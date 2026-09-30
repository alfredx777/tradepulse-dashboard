use rusqlite::Connection;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<Connection>,
}

fn init_db(db_path: std::path::PathBuf) -> Connection {
    let conn = Connection::open(db_path).expect("failed to open database");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS transactions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            product     TEXT NOT NULL,
            customer    TEXT NOT NULL,
            year        INTEGER NOT NULL,
            month       TEXT NOT NULL,
            quantity    INTEGER NOT NULL,
            total_value REAL NOT NULL
        )",
        [],
    )
    .expect("failed to create table");

    // Migrate older databases — errors harmlessly if the column already exists.
    let _ = conn.execute("ALTER TABLE transactions ADD COLUMN extra TEXT DEFAULT '{}'", []);

    conn.execute(
        "CREATE TABLE IF NOT EXISTS custom_fields (
            name        TEXT PRIMARY KEY,
            field_type  TEXT NOT NULL
        )",
        [],
    )
    .expect("failed to create custom_fields table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS products (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            name      TEXT NOT NULL,
            item_type TEXT NOT NULL DEFAULT '',
            size      TEXT NOT NULL DEFAULT '',
            UNIQUE(name, item_type, size)
        )",
        [],
    )
    .expect("failed to create products table");

    conn.execute(
        "CREATE TABLE IF NOT EXISTS batches (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_number TEXT NOT NULL UNIQUE,
            batch_date   TEXT,
            supplier     TEXT
        )",
        [],
    )
    .expect("failed to create batches table");

    // Migrate older databases — errors harmlessly if the columns already exist.
    let _ = conn.execute("ALTER TABLE transactions ADD COLUMN product_id INTEGER REFERENCES products(id)", []);
    let _ = conn.execute("ALTER TABLE transactions ADD COLUMN batch_id INTEGER REFERENCES batches(id)", []);

    // One-time backfill: link every existing transaction's free-text product name to a
    // real product row, creating one if it doesn't exist yet. Safe to run on every
    // startup — already-linked rows (product_id IS NOT NULL) are skipped.
    {
        let names: Vec<String> = {
            let mut stmt = conn
                .prepare("SELECT DISTINCT product FROM transactions WHERE product_id IS NULL AND product != ''")
                .expect("failed to prepare product migration query");
            stmt.query_map([], |row| row.get::<_, String>(0))
                .expect("failed to run product migration query")
                .filter_map(|r| r.ok())
                .collect()
        };
        for name in names {
            conn.execute(
                "INSERT INTO products (name, item_type, size) VALUES (?1, '', '')
                 ON CONFLICT(name, item_type, size) DO NOTHING",
                [&name],
            )
            .ok();
            let product_id: i64 = conn
                .query_row(
                    "SELECT id FROM products WHERE name = ?1 AND item_type = '' AND size = ''",
                    [&name],
                    |row| row.get(0),
                )
                .expect("failed to look up migrated product id");
            conn.execute(
                "UPDATE transactions SET product_id = ?1 WHERE product = ?2 AND product_id IS NULL",
                (&product_id, &name),
            )
            .ok();
        }
    }

    conn.execute(
        "CREATE TABLE IF NOT EXISTS batch_items (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            batch_id           INTEGER NOT NULL REFERENCES batches(id),
            seq_in_batch       INTEGER NOT NULL,
            item_code          TEXT NOT NULL UNIQUE,
            name               TEXT NOT NULL,
            size               TEXT NOT NULL DEFAULT '',
            price              REAL NOT NULL,
            initial_quantity   INTEGER NOT NULL,
            quantity_remaining INTEGER NOT NULL
        )",
        [],
    )
    .expect("failed to create batch_items table");

    let _ = conn.execute("ALTER TABLE transactions ADD COLUMN batch_item_id INTEGER REFERENCES batch_items(id)", []);

    conn
}

// Builds a traceable item code like "SHOE-B2024-01-003" from the item name,
// the batch's own number, and its position within that batch.
fn generate_item_code(name: &str, batch_number: &str, seq_in_batch: i64) -> String {
    let name_part: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(4)
        .collect::<String>()
        .to_uppercase();
    let name_part = if name_part.is_empty() { "ITEM".to_string() } else { name_part };
    format!("{}-{}-{:03}", name_part, batch_number, seq_in_batch)
}

#[derive(serde::Deserialize)]
struct BatchItemInput {
    name: String,
    size: String,
    price: f64,
    quantity: i64,
}

#[tauri::command]
fn create_batch(
    state: tauri::State<AppState>,
    batch_number: String,
    batch_date: String,
    supplier: String,
    items: Vec<BatchItemInput>,
) -> Result<i64, String> {
    let batch_number = batch_number.trim().to_string();
    if batch_number.is_empty() {
        return Err("Batch number cannot be empty".into());
    }
    if items.is_empty() {
        return Err("Add at least one item to the batch".into());
    }
    for item in &items {
        if item.name.trim().is_empty() {
            return Err("Every item needs a name".into());
        }
        if item.quantity < 0 {
            return Err("Quantity cannot be negative".into());
        }
    }

    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    tx.execute(
        "INSERT INTO batches (batch_number, batch_date, supplier) VALUES (?1, ?2, ?3)",
        (&batch_number, &batch_date, &supplier),
    ).map_err(|e| {
        if e.to_string().contains("UNIQUE") {
            "A batch with that number already exists".to_string()
        } else {
            e.to_string()
        }
    })?;
    let batch_id = tx.last_insert_rowid();

    for (i, item) in items.iter().enumerate() {
        let seq = (i as i64) + 1;
        let item_code = generate_item_code(&item.name, &batch_number, seq);
        tx.execute(
            "INSERT INTO batch_items (batch_id, seq_in_batch, item_code, name, size, price, initial_quantity, quantity_remaining)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            (&batch_id, &seq, &item_code, &item.name, &item.size, &item.price, &item.quantity, &item.quantity),
        ).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(batch_id)
}

#[derive(serde::Serialize)]
struct BatchSummary {
    id: i64,
    batch_number: String,
    batch_date: String,
    supplier: String,
    item_count: i64,
    total_remaining: i64,
}

#[tauri::command]
fn get_batches(state: tauri::State<AppState>) -> Result<Vec<BatchSummary>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT b.id, b.batch_number, COALESCE(b.batch_date,''), COALESCE(b.supplier,''),
                COUNT(bi.id), COALESCE(SUM(bi.quantity_remaining),0)
         FROM batches b
         LEFT JOIN batch_items bi ON bi.batch_id = b.id
         GROUP BY b.id
         ORDER BY b.id DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(BatchSummary {
            id: row.get(0)?,
            batch_number: row.get(1)?,
            batch_date: row.get(2)?,
            supplier: row.get(3)?,
            item_count: row.get(4)?,
            total_remaining: row.get(5)?,
        })
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows { result.push(row.map_err(|e| e.to_string())?); }
    Ok(result)
}

#[derive(serde::Serialize)]
struct BatchDetails {
    id: i64,
    batch_number: String,
    batch_date: String,
    supplier: String,
}

#[tauri::command]
fn get_batch(state: tauri::State<AppState>, batch_id: i64) -> Result<BatchDetails, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.query_row(
        "SELECT id, batch_number, COALESCE(batch_date,''), COALESCE(supplier,'') FROM batches WHERE id = ?1",
        [&batch_id],
        |row| Ok(BatchDetails {
            id: row.get(0)?,
            batch_number: row.get(1)?,
            batch_date: row.get(2)?,
            supplier: row.get(3)?,
        }),
    ).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct BatchItem {
    id: i64,
    batch_id: i64,
    seq_in_batch: i64,
    item_code: String,
    name: String,
    size: String,
    price: f64,
    initial_quantity: i64,
    quantity_remaining: i64,
}

#[tauri::command]
fn get_batch_items(state: tauri::State<AppState>, batch_id: i64) -> Result<Vec<BatchItem>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT id, batch_id, seq_in_batch, item_code, name, size, price, initial_quantity, quantity_remaining
         FROM batch_items WHERE batch_id = ?1 ORDER BY seq_in_batch"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&batch_id], |row| {
        Ok(BatchItem {
            id: row.get(0)?,
            batch_id: row.get(1)?,
            seq_in_batch: row.get(2)?,
            item_code: row.get(3)?,
            name: row.get(4)?,
            size: row.get(5)?,
            price: row.get(6)?,
            initial_quantity: row.get(7)?,
            quantity_remaining: row.get(8)?,
        })
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows { result.push(row.map_err(|e| e.to_string())?); }
    Ok(result)
}

#[tauri::command]
fn record_batch_sale(
    state: tauri::State<AppState>,
    batch_item_id: i64,
    customer: String,
    quantity: i64,
    is_return: bool,
    year: i64,
    month: String,
) -> Result<(), String> {
    if quantity <= 0 {
        return Err("Quantity must be greater than zero".into());
    }
    let customer = customer.trim().to_string();
    if customer.is_empty() {
        return Err("Customer name is required".into());
    }

    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let (batch_id, name, size, price, initial_quantity, remaining): (i64, String, String, f64, i64, i64) = tx.query_row(
        "SELECT batch_id, name, size, price, initial_quantity, quantity_remaining FROM batch_items WHERE id = ?1",
        [&batch_item_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
    ).map_err(|e| e.to_string())?;

    let new_remaining = if is_return {
        if remaining + quantity > initial_quantity {
            return Err(format!("Cannot return more than {} unit(s) without exceeding the original batch quantity", initial_quantity - remaining));
        }
        remaining + quantity
    } else {
        if quantity > remaining {
            return Err(format!("Only {} unit(s) remaining", remaining));
        }
        remaining - quantity
    };

    tx.execute(
        "UPDATE batch_items SET quantity_remaining = ?1 WHERE id = ?2",
        (&new_remaining, &batch_item_id),
    ).map_err(|e| e.to_string())?;

    let product_name = if size.trim().is_empty() { name.clone() } else { format!("{} ({})", name, size) };
    let signed_quantity: i64 = if is_return { -quantity } else { quantity };
    let total_value = price * (signed_quantity as f64);

    tx.execute(
        "INSERT INTO transactions (product, customer, year, month, quantity, total_value, extra, batch_id, batch_item_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, '{}', ?7, ?8)",
        (&product_name, &customer, &year, &month, &signed_quantity, &total_value, &batch_id, &batch_item_id),
    ).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn add_batch_item(state: tauri::State<AppState>, batch_id: i64, name: String, size: String, price: f64, quantity: i64) -> Result<i64, String> {
    if name.trim().is_empty() { return Err("Item name cannot be empty".into()); }
    if quantity < 0 { return Err("Quantity cannot be negative".into()); }

    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let batch_number: String = tx.query_row(
        "SELECT batch_number FROM batches WHERE id = ?1", [&batch_id], |row| row.get(0)
    ).map_err(|e| e.to_string())?;

    let next_seq: i64 = tx.query_row(
        "SELECT COALESCE(MAX(seq_in_batch), 0) + 1 FROM batch_items WHERE batch_id = ?1", [&batch_id], |row| row.get(0)
    ).map_err(|e| e.to_string())?;

    let item_code = generate_item_code(&name, &batch_number, next_seq);

    tx.execute(
        "INSERT INTO batch_items (batch_id, seq_in_batch, item_code, name, size, price, initial_quantity, quantity_remaining)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        (&batch_id, &next_seq, &item_code, &name, &size, &price, &quantity, &quantity),
    ).map_err(|e| e.to_string())?;

    let item_id = tx.last_insert_rowid();
    tx.commit().map_err(|e| e.to_string())?;
    Ok(item_id)
}

#[tauri::command]
fn delete_batch_item(state: tauri::State<AppState>, item_id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM batch_items WHERE id = ?1", [&item_id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_batch(state: tauri::State<AppState>, batch_id: i64, confirm_batch_number: String) -> Result<(), String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let actual_number: String = tx.query_row(
        "SELECT batch_number FROM batches WHERE id = ?1", [&batch_id], |row| row.get(0)
    ).map_err(|e| e.to_string())?;

    if actual_number.trim().to_lowercase() != confirm_batch_number.trim().to_lowercase() {
        return Err("Batch number does not match".into());
    }

    // Sales already recorded stay in transaction history — just disconnect them from
    // the batch being deleted, rather than deleting real sales history.
    tx.execute("UPDATE transactions SET batch_id = NULL, batch_item_id = NULL WHERE batch_id = ?1", [&batch_id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM batch_items WHERE batch_id = ?1", [&batch_id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM batches WHERE id = ?1", [&batch_id]).map_err(|e| e.to_string())?;

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct CustomField {
    name: String,
    field_type: String,
}

#[tauri::command]
fn add_custom_field(state: tauri::State<AppState>, name: String, field_type: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Field name cannot be empty".into());
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO custom_fields (name, field_type) VALUES (?1, ?2)",
        (&name, &field_type),
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_custom_fields(state: tauri::State<AppState>) -> Result<Vec<CustomField>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT name, field_type FROM custom_fields ORDER BY rowid").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |row| {
        Ok(CustomField { name: row.get(0)?, field_type: row.get(1)? })
    }).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for row in rows { result.push(row.map_err(|e| e.to_string())?); }
    Ok(result)
}

#[tauri::command]
fn remove_custom_field(state: tauri::State<AppState>, name: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM custom_fields WHERE name = ?1", [&name])
        .map_err(|e| e.to_string())?;
    Ok(())
}

use calamine::{open_workbook, DataType, Reader, Xlsx};
use std::collections::HashSet;
use std::fs::File;
use std::io::BufReader;

fn parse_number(cell: Option<&calamine::Data>) -> f64 {
    match cell {
        Some(c) => {
            if let Some(v) = c.as_f64() {
                v
            } else if let Some(v) = c.as_i64() {
                v as f64
            } else {
                let raw = c.to_string();
                let is_parenthesized_negative = raw.trim().starts_with('(') && raw.trim().ends_with(')');
                let cleaned: String = raw
                    .chars()
                    .filter(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '-')
                    .collect();
                let value = cleaned.parse::<f64>().unwrap_or(0.0);
                if is_parenthesized_negative && value > 0.0 { -value } else { value }
            }
        }
        None => 0.0,
    }
}

#[tauri::command]
fn get_excel_headers(path: String) -> Result<Vec<String>, String> {
    let workbook_result: Result<Xlsx<BufReader<File>>, calamine::XlsxError> = open_workbook(&path);
    let mut workbook = match workbook_result {
        Ok(wb) => wb,
        Err(e) => return Err(e.to_string()),
    };

    let sheet_result = workbook
        .worksheet_range_at(0)
        .ok_or("No sheet found in file")?;
    let range = match sheet_result {
        Ok(r) => r,
        Err(e) => return Err(e.to_string()),
    };

    let mut rows = range.rows();
    let header = rows.next().ok_or("File is empty")?;
    Ok(header.iter().map(|c| c.to_string()).collect())
}

#[derive(serde::Deserialize)]
struct ColumnRole {
    index: usize,
    role: String, // "product" | "customer" | "year" | "month" | "quantity" | "total_value" | "custom" | "skip"
    field_name: Option<String>,
    field_type: Option<String>,
}

#[tauri::command]
fn import_excel(state: tauri::State<AppState>, path: String, columns: Vec<ColumnRole>) -> Result<usize, String> {
    let workbook_result: Result<Xlsx<BufReader<File>>, calamine::XlsxError> = open_workbook(&path);
    let mut workbook = match workbook_result {
        Ok(wb) => wb,
        Err(e) => return Err(e.to_string()),
    };

    let sheet_result = workbook
        .worksheet_range_at(0)
        .ok_or("No sheet found in file")?;
    let range = match sheet_result {
        Ok(r) => r,
        Err(e) => return Err(e.to_string()),
    };

    let mut rows = range.rows();
    let header = rows.next().ok_or("File is empty")?;

    let mut col_product: Option<usize> = None;
    let mut col_customer: Option<usize> = None;
    let mut col_year: Option<usize> = None;
    let mut col_month: Option<usize> = None;
    let mut col_quantity: Option<usize> = None;
    let mut col_value: Option<usize> = None;
    let mut custom_cols: Vec<(usize, String, String)> = Vec::new(); // (col_idx, field_name, field_type)
    let mut custom_names = HashSet::new();

    for c in &columns {
        let col_idx = c.index;
        if col_idx >= header.len() {
            return Err("A mapped column is outside the spreadsheet header range".into());
        }
        match c.role.as_str() {
            "product" => if col_product.replace(col_idx).is_some() { return Err("Map only one column to Product".into()); },
            "customer" => if col_customer.replace(col_idx).is_some() { return Err("Map only one column to Customer".into()); },
            "year" => if col_year.replace(col_idx).is_some() { return Err("Map only one column to Year".into()); },
            "month" => if col_month.replace(col_idx).is_some() { return Err("Map only one column to Month".into()); },
            "quantity" => if col_quantity.replace(col_idx).is_some() { return Err("Map only one column to Quantity".into()); },
            "total_value" => if col_value.replace(col_idx).is_some() { return Err("Map only one column to Total Value".into()); },
            "custom" => {
                let name = c.field_name.clone().unwrap_or_default().trim().to_string();
                if name.is_empty() { return Err("Custom fields need a name".into()); }
                let ftype = c.field_type.clone().unwrap_or_else(|| "text".to_string());
                if ftype != "text" && ftype != "number" {
                    return Err("Custom field types must be text or number".into());
                }
                if !custom_names.insert(name.to_lowercase()) {
                    return Err("Custom field names must be unique".into());
                }
                custom_cols.push((col_idx, name, ftype));
            }
            _ => {} // "skip" or anything unrecognized
        }
    }

    let col_product = col_product.ok_or("Map a column to \"Product\" before importing")?;
    let col_customer = col_customer.ok_or("Map a column to \"Customer\" before importing")?;
    let col_year = col_year.ok_or("Map a column to \"Year\" before importing")?;
    let col_month = col_month.ok_or("Map a column to \"Month\" before importing")?;
    let col_quantity = col_quantity.ok_or("Map a column to \"Quantity\" before importing")?;
    let col_value = col_value.ok_or("Map a column to \"Total Value\" before importing")?;

    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    for (_, name, ftype) in &custom_cols {
        tx.execute(
            "INSERT INTO custom_fields (name, field_type) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET field_type = excluded.field_type",
            (name, ftype),
        ).map_err(|e| e.to_string())?;
    }

    let mut count = 0;

    for row in rows {
        let product = row.get(col_product).map(|c| c.to_string()).unwrap_or_default();
        if product.trim().is_empty() { continue; }

        let customer = row.get(col_customer).map(|c| c.to_string()).unwrap_or_default();
        let year = parse_number(row.get(col_year)) as i64;
        let month = row.get(col_month).map(|c| c.to_string()).unwrap_or_default();
        let quantity = parse_number(row.get(col_quantity)) as i64;
        let total_value = parse_number(row.get(col_value));

        let mut extra_map = serde_json::Map::new();
        for (col_idx, field_name, _) in &custom_cols {
            if let Some(cell) = row.get(*col_idx) {
                let val = cell.to_string();
                if !val.is_empty() {
                    extra_map.insert(field_name.clone(), serde_json::Value::String(val));
                }
            }
        }
        let extra_json = serde_json::Value::Object(extra_map).to_string();

        tx.execute(
            "INSERT INTO transactions (product, customer, year, month, quantity, total_value, extra) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (&product, &customer, &year, &month, &quantity, &total_value, &extra_json),
        ).map_err(|e| e.to_string())?;

        count += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[derive(serde::Serialize)]
struct Transaction {
    id: i64,
    product: String,
    customer: String,
    year: i64,
    month: String,
    quantity: i64,
    total_value: f64,
    extra: String,
}

#[tauri::command]
fn get_transactions(state: tauri::State<AppState>) -> Result<Vec<Transaction>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let mut stmt = conn
        .prepare("SELECT id, product, customer, year, month, quantity, total_value, COALESCE(extra, '{}') FROM transactions")
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            Ok(Transaction {
                id: row.get(0)?,
                product: row.get(1)?,
                customer: row.get(2)?,
                year: row.get(3)?,
                month: row.get(4)?,
                quantity: row.get(5)?,
                total_value: row.get(6)?,
                extra: row.get(7)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for row in rows {
        result.push(row.map_err(|e| e.to_string())?);
    }

    Ok(result)
}

#[tauri::command]
fn export_report(save_path: String, columns: Vec<String>, rows: Vec<Vec<String>>, numeric_cols: Vec<usize>) -> Result<(), String> {
    use rust_xlsxwriter::Workbook;

    let mut workbook = Workbook::new();
    let sheet = workbook.add_worksheet();

    for (col_idx, header) in columns.iter().enumerate() {
        sheet.write_string(0, col_idx as u16, header).map_err(|e| e.to_string())?;
    }

    for (row_idx, row) in rows.iter().enumerate() {
        for (col_idx, value) in row.iter().enumerate() {
            let row_number = (row_idx + 1) as u32;
            if numeric_cols.contains(&col_idx) {
                let cleaned: String = value
                    .chars()
                    .filter(|ch| ch.is_ascii_digit() || *ch == '.' || *ch == '-')
                    .collect();
                if let Ok(number) = cleaned.parse::<f64>() {
                    sheet.write_number(row_number, col_idx as u16, number).map_err(|e| e.to_string())?;
                    continue;
                }
            }
            sheet.write_string(row_number, col_idx as u16, value).map_err(|e| e.to_string())?;
        }
    }

    workbook.save(&save_path).map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn clear_data(state: tauri::State<AppState>) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM transactions", [])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Deserialize)]
struct TransactionInput {
    product: String,
    customer: String,
    year: i64,
    month: String,
    quantity: i64,
    total_value: f64,
    extra: String,
}

#[tauri::command]
fn add_transactions(state: tauri::State<AppState>, rows: Vec<TransactionInput>) -> Result<usize, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut count = 0;

    for row in &rows {
        if row.product.trim().is_empty() { continue; }
        let extra_val = if row.extra.trim().is_empty() { "{}".to_string() } else { row.extra.clone() };
        tx.execute(
            "INSERT INTO transactions (product, customer, year, month, quantity, total_value, extra) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            (&row.product, &row.customer, &row.year, &row.month, &row.quantity, &row.total_value, &extra_val),
        ).map_err(|e| e.to_string())?;
        count += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[derive(serde::Deserialize)]
struct TransactionUpdate {
    id: i64,
    product: String,
    customer: String,
    year: i64,
    month: String,
    quantity: i64,
    total_value: f64,
    extra: String,
}

#[tauri::command]
fn update_transactions(state: tauri::State<AppState>, rows: Vec<TransactionUpdate>) -> Result<usize, String> {
    let mut conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    let mut count = 0;

    for row in &rows {
        if row.product.trim().is_empty() {
            return Err("Product cannot be empty when updating a transaction".into());
        }
        let extra_val = if row.extra.trim().is_empty() { "{}".to_string() } else { row.extra.clone() };
        tx.execute(
            "UPDATE transactions SET product = ?1, customer = ?2, year = ?3, month = ?4, quantity = ?5, total_value = ?6, extra = ?7 WHERE id = ?8",
            (&row.product, &row.customer, &row.year, &row.month, &row.quantity, &row.total_value, &extra_val, &row.id),
        ).map_err(|e| e.to_string())?;
        count += 1;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
fn delete_transaction(state: tauri::State<AppState>, id: i64) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM transactions WHERE id = ?1", [&id])
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data directory");

            std::fs::create_dir_all(&app_data_dir)
                .expect("failed to create app data directory");

            let db_path = app_data_dir.join("trader.db");
            let db = init_db(db_path);

            app.manage(AppState { db: Mutex::new(db) });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![greet, import_excel, get_excel_headers, get_transactions, export_report, clear_data, add_transactions, update_transactions, delete_transaction, add_custom_field, get_custom_fields, remove_custom_field, create_batch, get_batches, get_batch, get_batch_items, record_batch_sale, add_batch_item, delete_batch_item, delete_batch])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

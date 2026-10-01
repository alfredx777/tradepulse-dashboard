import { useState, useEffect, useMemo } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Transaction, CustomField } from "./types";
import { guessRole, STANDARD_HEADER_NAMES, STANDARD_ROLE_OPTIONS, type ImportMapping } from "./importMapping";
import Sheet from "./Sheet";
import Batches from "./Batches";
import BatchDetail from "./BatchDetail";

function parseExtra(extra: string | undefined): Record<string, string> {
  if (!extra) return {};
  try { return JSON.parse(extra); } catch { return {}; }
}

const MONTH_ORDER = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const BASE_FILTER_FIELDS: { key: string; label: string; field: keyof Transaction }[] = [
  { key: "product", label: "Product", field: "product" },
  { key: "customer", label: "Customer", field: "customer" },
  { key: "year", label: "Year", field: "year" },
  { key: "month", label: "Month", field: "month" },
];

function money(n: number): string {
  return "GHS " + Math.round(n).toLocaleString();
}

function compactMoney(n: number): string {
  if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(1) + "M";
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + "k";
  return Math.round(n).toString();
}

// Strips everything except digits, a single leading minus, and a single decimal point —
// used to hard-lock "number" fields so letters can never be typed in.
function sanitizeNumericInput(value: string): string {
  let v = value.replace(/[^0-9.\-]/g, "");
  const negative = v.startsWith("-");
  v = v.replace(/-/g, "");
  const firstDot = v.indexOf(".");
  if (firstDot !== -1) {
    v = v.slice(0, firstDot + 1) + v.slice(firstDot + 1).replace(/\./g, "");
  }
  return (negative ? "-" : "") + v;
}

function parseNumericValue(value: string | number): number | null {
  const cleaned = String(value).replace(/[^0-9.\-]/g, "");
  if (cleaned === "") return 0;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

const TREND_CHART_WIDTH = 640;
const TREND_CHART_HEIGHT = 220;
const TREND_PADDING = { top: 34, bottom: 40, left: 16, right: 16 };

function App() {
  const [rows, setRows] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<"dashboard" | "trends" | "sheet" | "batches">("dashboard");
  const [openBatchId, setOpenBatchId] = useState<number | null>(null);

  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});

  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [showNewFieldForm, setShowNewFieldForm] = useState(false);
  const [newFieldName, setNewFieldName] = useState("");
  const [newFieldType, setNewFieldType] = useState("text");

  const [importPath, setImportPath] = useState<string | null>(null);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  // Keys are header positions, not header text: spreadsheets may contain duplicate labels.
  const [importMappings, setImportMappings] = useState<Record<string, ImportMapping>>({});
  const [showImportMapper, setShowImportMapper] = useState(false);
  const [importing, setImporting] = useState(false);

  const FILTER_FIELDS = useMemo(
    () => [
      ...BASE_FILTER_FIELDS,
      ...customFields.map(cf => ({ key: `custom:${cf.name}`, label: cf.name, field: "extra" as keyof Transaction })),
    ],
    [customFields]
  );

  const [reportType, setReportType] = useState("log");
  type NumericCol = { index: number; format: "int" | "money" };
  const [report, setReport] = useState<{ title: string; columns: string[]; rows: (string | number)[][]; numericCols?: NumericCol[]; rowIds?: (number | null)[]; fieldKeys?: string[]; allowAddRow?: boolean } | null>(null);
  const [sortState, setSortState] = useState<{ index: number; dir: "asc" | "desc" } | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [savingEdits, setSavingEdits] = useState(false);
  const [deletingRowId, setDeletingRowId] = useState<number | null>(null);

  function updateReportCell(rowIndex: number, colIndex: number, value: string) {
    setReport(prev => {
      if (!prev) return prev;
      const rows = prev.rows.map((r, i) => i === rowIndex ? r.map((v, j) => j === colIndex ? value : v) : r);
      return { ...prev, rows };
    });
  }

  // Recomputed on every render, so editing a number cell updates TOTAL immediately.
  const displayTotals = useMemo(() => {
    if (!report || !report.numericCols || report.numericCols.length === 0) return null;
    const totals: (string | number)[] = report.columns.map(() => "");
    totals[0] = "TOTAL";
    report.numericCols.forEach(({ index, format }) => {
      const sum = report.rows.reduce((s, r) => {
        const cleaned = String(r[index] ?? "").replace(/[^0-9.\-]/g, "");
        return s + (parseFloat(cleaned) || 0);
      }, 0);
      totals[index] = format === "money" ? money(sum) : Math.round(sum);
    });
    return totals;
  }, [report]);

  // Merges edited display values (for only the columns this report shows) into a copy of the
  // original transaction, so fields not shown in this view stay untouched.
  function buildUpdatePayload(row: (string | number)[], fieldKeys: string[], original: Transaction) {
    const parseNum = (v: string | number) => parseNumericValue(v) ?? 0;
    let product = original.product;
    let customer = original.customer;
    let year = original.year;
    let month = original.month;
    let quantity = original.quantity;
    let total_value = original.total_value;
    const extraObj: Record<string, string> = { ...parseExtra(original.extra) };

    fieldKeys.forEach((key, j) => {
      const val = row[j];
      if (key === "product") product = String(val ?? "");
      else if (key === "customer") customer = String(val ?? "");
      else if (key === "year") year = Math.round(parseNum(val));
      else if (key === "month") month = String(val ?? "");
      else if (key === "quantity") quantity = Math.round(parseNum(val));
      else if (key === "total_value") total_value = parseNum(val);
      else if (key.startsWith("custom:")) extraObj[key.slice("custom:".length)] = String(val ?? "");
    });

    return { id: original.id, product, customer, year, month, quantity, total_value, extra: JSON.stringify(extraObj) };
  }

  function buildInsertPayload(row: (string | number)[], fieldKeys: string[]) {
    const parseNum = (v: string | number) => parseNumericValue(v) ?? 0;
    let product = "";
    let customer = "";
    let year = new Date().getFullYear();
    let month = "";
    let quantity = 0;
    let total_value = 0;
    const extraObj: Record<string, string> = {};

    fieldKeys.forEach((key, j) => {
      const val = row[j];
      if (key === "product") product = String(val ?? "");
      else if (key === "customer") customer = String(val ?? "");
      else if (key === "year") year = Math.round(parseNum(val));
      else if (key === "month") month = String(val ?? "");
      else if (key === "quantity") quantity = Math.round(parseNum(val));
      else if (key === "total_value") total_value = parseNum(val);
      else if (key.startsWith("custom:")) extraObj[key.slice("custom:".length)] = String(val ?? "");
    });

    return { product, customer, year, month, quantity, total_value, extra: JSON.stringify(extraObj) };
  }

  async function handleToggleEdit() {
    if (!editMode) {
      setEditMode(true);
      return;
    }
    // Any view with fieldKeys + rowIds maps back to real rows, so any such view can save.
    if (report?.fieldKeys && report.rowIds && report.rowIds.length === report.rows.length) {
      const hasInvalidNumber = report.rows.some(row =>
        report.numericCols?.some(({ index }) => parseNumericValue(row[index]) === null)
      );
      if (hasInvalidNumber) {
        alert("Enter a valid number before saving.");
        return;
      }
      setSavingEdits(true);
      try {
        const updateRows: ReturnType<typeof buildUpdatePayload>[] = [];
        const insertRows: ReturnType<typeof buildInsertPayload>[] = [];
        report.rows.forEach((row, i) => {
          const id = report.rowIds![i];
          if (id !== null) {
            const original = rows.find(r => r.id === id);
            if (original) updateRows.push(buildUpdatePayload(row, report.fieldKeys!, original));
          } else if (report.allowAddRow) {
            const hasContent = report.fieldKeys!.some((_, j) => String(row[j] ?? "").trim() !== "");
            if (hasContent) insertRows.push(buildInsertPayload(row, report.fieldKeys!));
          }
        });
        if (updateRows.length > 0) {
          await invoke("update_transactions", { rows: updateRows });
        }
        if (insertRows.length > 0) {
          await invoke("add_transactions", { rows: insertRows });
        }
        await loadData();
      } catch (err) {
        alert(`Failed to save changes: ${err}`);
        setSavingEdits(false);
        return;
      }
      setSavingEdits(false);
    }
    setEditMode(false);
  }

  function addReportRow() {
    setReport(prev => {
      if (!prev || !prev.rowIds || !prev.allowAddRow) return prev;
      const emptyRow: (string | number)[] = prev.columns.map((_, idx) => {
        if (prev.fieldKeys && prev.fieldKeys[idx] === "year") return new Date().getFullYear();
        return prev.numericCols?.some(c => c.index === idx) ? 0 : "";
      });
      return {
        ...prev,
        rows: [...prev.rows, emptyRow],
        rowIds: [...prev.rowIds, null],
      };
    });
  }

  async function removeReportRow(rowIndex: number) {
    if (!report || !report.rowIds) return;
    const id = report.rowIds[rowIndex];

    function dropLocally() {
      setReport(prev => {
        if (!prev || !prev.rowIds) return prev;
        const keptIndices = prev.rowIds
          .map((rowId, index) => ({ rowId, index }))
          .filter(({ rowId, index }) => id === null ? index !== rowIndex : rowId !== id)
          .map(({ index }) => index);
        return {
          ...prev,
          rows: keptIndices.map(index => prev.rows[index]),
          rowIds: keptIndices.map(index => prev.rowIds![index]),
        };
      });
    }

    if (id === null) {
      // Unsaved row — nothing in the database yet, just drop it from the view.
      dropLocally();
      return;
    }

    const confirmed = window.confirm("Permanently delete this transaction from the database? This cannot be undone.");
    if (!confirmed) return;

    setDeletingRowId(id);
    try {
      await invoke("delete_transaction", { id });
      dropLocally();
      await loadData();
    } catch (err) {
      alert(`Failed to delete: ${err}`);
    } finally {
      setDeletingRowId(null);
    }
  }

  function handleSort(colIndex: number) {
    if (!report) return;
    const isNumeric = report.numericCols?.some(c => c.index === colIndex) ?? false;
    const nextDir: "asc" | "desc" = sortState && sortState.index === colIndex && sortState.dir === "asc" ? "desc" : "asc";
    const indices = report.rows.map((_, i) => i);
    indices.sort((a, b) => {
      const va = report.rows[a][colIndex];
      const vb = report.rows[b][colIndex];
      let cmp: number;
      if (isNumeric) {
        const na = parseFloat(String(va).replace(/[^0-9.\-]/g, "")) || 0;
        const nb = parseFloat(String(vb).replace(/[^0-9.\-]/g, "")) || 0;
        cmp = na - nb;
      } else {
        cmp = String(va).localeCompare(String(vb));
      }
      return nextDir === "asc" ? cmp : -cmp;
    });
    setReport({
      ...report,
      rows: indices.map(i => report.rows[i]),
      rowIds: report.rowIds ? indices.map(i => report.rowIds![i]) : undefined,
    });
    setSortState({ index: colIndex, dir: nextDir });
  }

  async function loadData() {
    setLoading(true);
    try {
      const data = await invoke<Transaction[]>("get_transactions");
      setRows(data);
    } catch (err) {
      alert(`Failed to load data: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  async function loadCustomFields() {
    try {
      const fields = await invoke<CustomField[]>("get_custom_fields");
      setCustomFields(fields);
    } catch (err) {
      console.error("Failed to load custom fields:", err);
    }
  }

  useEffect(() => {
    loadData();
    loadCustomFields();
  }, []);

  async function handleAddCustomField() {
    const name = newFieldName.trim();
    if (!name) { alert("Give the field a name."); return; }
    if (customFields.some(cf => cf.name.toLowerCase() === name.toLowerCase())) {
      alert("A field with that name already exists.");
      return;
    }
    try {
      await invoke("add_custom_field", { name, fieldType: newFieldType });
      await loadCustomFields();
      setNewFieldName("");
      setNewFieldType("text");
      setShowNewFieldForm(false);
    } catch (err) {
      alert(`Failed to add field: ${err}`);
    }
  }

  async function handleRemoveCustomField(name: string) {
    const confirmed = window.confirm(
      `Remove the "${name}" field from filters and forms? Any values already saved for it will stay in the database in case you re-add a field with the same name later.`
    );
    if (!confirmed) return;
    try {
      await invoke("remove_custom_field", { name });
      await loadCustomFields();
      const filterKey = `custom:${name}`;
      if (activeFilters.includes(filterKey)) {
        handleRemoveFilter(filterKey);
      }
    } catch (err) {
      alert(`Failed to remove field: ${err}`);
    }
  }

  function renderCustomFieldsChips() {
    if (customFields.length === 0) return null;
    return (
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", marginBottom: "12px" }}>
        {customFields.map(cf => (
          <span
            key={cf.name}
            style={{ display: "inline-flex", alignItems: "center", gap: "6px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", padding: "4px 10px", fontSize: "12px", color: "#8B98B4" }}
          >
            {cf.name}
            <span className="remove" style={{ cursor: "pointer" }} onClick={() => handleRemoveCustomField(cf.name)}>✕</span>
          </span>
        ))}
      </div>
    );
  }

  async function handleImport() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!selected) return;

      const headers = await invoke<string[]>("get_excel_headers", { path: selected });
      const normalized = headers.map(h => h.trim().toLowerCase());
      const isExactStandard = normalized.length === STANDARD_HEADER_NAMES.length && STANDARD_HEADER_NAMES.every(n => normalized.includes(n));

      if (isExactStandard) {
        setImporting(true);
        try {
          const columns = headers.map((h, index) => ({ index, role: guessRole(h) ?? "skip", field_name: null, field_type: null }));
          const count = await invoke<number>("import_excel", { path: selected, columns });
          alert(`Imported ${count} transactions successfully.`);
          await loadData();
        } finally {
          setImporting(false);
        }
        return;
      }

      const initialMappings: Record<string, ImportMapping> = {};
      const usedRoles = new Set<string>();
      headers.forEach((h, index) => {
        const guessed = guessRole(h);
        if (guessed && !usedRoles.has(guessed)) {
          usedRoles.add(guessed);
          initialMappings[String(index)] = { role: guessed, fieldName: h.trim(), fieldType: "text" };
        } else {
          const existing = customFields.find(cf => cf.name.toLowerCase() === h.trim().toLowerCase());
          initialMappings[String(index)] = existing
            ? { role: "custom", fieldName: existing.name, fieldType: existing.field_type === "number" ? "number" : "text" }
            : { role: "custom", fieldName: h.trim(), fieldType: "text" };
        }
      });
      setImportPath(selected);
      setImportHeaders(headers);
      setImportMappings(initialMappings);
      setShowImportMapper(true);
    } catch (err) {
      alert(`Import failed: ${err}`);
    }
  }

  function updateImportMapping(index: number, patch: Partial<ImportMapping>) {
    const key = String(index);
    setImportMappings(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  async function handleConfirmImport() {
    if (!importPath) return;
    const requiredRoles = ["product", "customer", "year", "month", "quantity", "total_value"];
    const roleCounts = requiredRoles.map(role => ({
      role,
      count: importHeaders.filter((_, index) => importMappings[String(index)]?.role === role).length,
    }));
    const invalidRole = roleCounts.find(({ count }) => count !== 1);
    if (invalidRole) {
      alert(`Map exactly one column to ${STANDARD_ROLE_OPTIONS.find(option => option.value === invalidRole.role)?.label ?? invalidRole.role} before importing.`);
      return;
    }
    const customNames = importHeaders
      .map((_, index) => importMappings[String(index)])
      .filter(mapping => mapping?.role === "custom")
      .map(mapping => mapping.fieldName.trim().toLowerCase());
    if (customNames.some(name => !name) || new Set(customNames).size !== customNames.length) {
      alert("Each custom column needs a unique field name before importing.");
      return;
    }
    const columns = importHeaders
      .map((_, index) => {
        const m = importMappings[String(index)];
        const isCustom = m.role === "custom";
        return {
          index,
          role: m.role,
          field_name: isCustom ? m.fieldName.trim() : null,
          field_type: isCustom ? m.fieldType : null,
        };
      })
      .filter(c => c.role !== "skip");

    setImporting(true);
    try {
      const count = await invoke<number>("import_excel", { path: importPath, columns });
      alert(`Imported ${count} transactions successfully.`);
      await loadData();
      await loadCustomFields();
      setShowImportMapper(false);
      setImportPath(null);
      setImportHeaders([]);
      setImportMappings({});
    } catch (err) {
      alert(`Import failed: ${err}`);
    } finally {
      setImporting(false);
    }
  }

  function handleCancelImport() {
    setShowImportMapper(false);
    setImportPath(null);
    setImportHeaders([]);
    setImportMappings({});
  }

  async function handleClearData() {
    const confirmed = window.confirm("This will permanently delete all transactions from the database. Are you sure?");
    if (!confirmed) return;
    try {
      await invoke("clear_data");
      setReport(null);
      await loadData();
      alert("All data cleared.");
    } catch (err) {
      alert(`Failed to clear data: ${err}`);
    }
  }

  function handleClearFilters() {
    const reset: Record<string, string> = {};
    activeFilters.forEach(k => { reset[k] = "all"; });
    setFilterValues(reset);
    setReport(null);
    setEditMode(false);
    setSortState(null);
    setDeletingRowId(null);
  }

  function handleAddFilter(key: string) {
    if (!key || activeFilters.includes(key)) return;
    setActiveFilters([...activeFilters, key]);
    setFilterValues({ ...filterValues, [key]: "all" });
  }

  function handleRemoveFilter(key: string) {
    setActiveFilters(activeFilters.filter(k => k !== key));
    const next = { ...filterValues };
    delete next[key];
    setFilterValues(next);
  }

  function uniqueValues(key: string, field: keyof Transaction): string[] {
    if (key.startsWith("custom:")) {
      const name = key.slice("custom:".length);
      return [...new Set(rows.map(r => parseExtra(r.extra)[name] ?? "").filter(v => v !== ""))].sort();
    }
    return [...new Set(rows.map(r => String(r[field])))].sort();
  }

  const productSuggestions = useMemo(
    () => [...new Set(rows.map(r => r.product))].filter(v => v.trim() !== "").sort(),
    [rows]
  );
  const customerSuggestions = useMemo(
    () => [...new Set(rows.map(r => r.customer))].filter(v => v.trim() !== "").sort(),
    [rows]
  );
  function customFieldSuggestions(name: string): string[] {
    return [...new Set(rows.map(r => parseExtra(r.extra)[name] ?? "").filter(v => v !== ""))].sort();
  }

  const availableToAdd = FILTER_FIELDS.filter(f => !activeFilters.includes(f.key));

  const metrics = useMemo(() => {
    if (rows.length === 0) return null;

    const byProduct: Record<string, number> = {};
    rows.forEach(r => { byProduct[r.product] = (byProduct[r.product] || 0) + r.quantity; });
    const topProduct = Object.entries(byProduct).sort((a, b) => b[1] - a[1])[0];

    const byCustomer: Record<string, number> = {};
    rows.forEach(r => { byCustomer[r.customer] = (byCustomer[r.customer] || 0) + r.total_value; });
    const topCustomer = Object.entries(byCustomer).sort((a, b) => b[1] - a[1])[0];

    const byMonthYear: Record<string, number> = {};
    rows.forEach(r => { const k = `${r.month} ${r.year}`; byMonthYear[k] = (byMonthYear[k] || 0) + r.total_value; });
    const topMonth = Object.entries(byMonthYear).sort((a, b) => b[1] - a[1])[0];

    return { topProduct, topCustomer, topMonth };
  }, [rows]);

  const monthlyTrend = useMemo(() => {
    const agg: Record<string, { year: number; monthIndex: number; month: string; value: number }> = {};
    rows.forEach(r => {
      const knownMonthIndex = MONTH_ORDER.indexOf(r.month);
      const monthIndex = knownMonthIndex === -1 ? MONTH_ORDER.length : knownMonthIndex;
      const key = `${r.year}-${r.month}`;
      if (!agg[key]) agg[key] = { year: r.year, monthIndex, month: r.month, value: 0 };
      agg[key].value += r.total_value;
    });
    const list = Object.values(agg).sort((a, b) => a.year - b.year || a.monthIndex - b.monthIndex);
    return list.map((entry, i) => {
      const prev = i > 0 ? list[i - 1] : null;
      const change = prev && prev.value !== 0 ? ((entry.value - prev.value) / prev.value) * 100 : null;
      return { ...entry, change };
    });
  }, [rows]);

  const latestTrend = monthlyTrend.length > 0 ? monthlyTrend[monthlyTrend.length - 1] : null;
  const previousTrend = monthlyTrend.length > 1 ? monthlyTrend[monthlyTrend.length - 2] : null;

  const trendChart = useMemo(() => {
    if (monthlyTrend.length < 2) return null;
    const plotWidth = TREND_CHART_WIDTH - TREND_PADDING.left - TREND_PADDING.right;
    const plotHeight = TREND_CHART_HEIGHT - TREND_PADDING.top - TREND_PADDING.bottom;
    const values = monthlyTrend.map(m => m.value);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const range = (max - min) || 1;

    const points = monthlyTrend.map((m, i) => {
      const x = TREND_PADDING.left + (i / (monthlyTrend.length - 1)) * plotWidth;
      const y = TREND_PADDING.top + plotHeight - ((m.value - min) / range) * plotHeight;
      return { x, y, m };
    });

    const linePoints = points.map(p => `${p.x},${p.y}`).join(" ");
    const gridLines = [0, 0.25, 0.5, 0.75, 1].map(f => TREND_PADDING.top + plotHeight * f);

    return { points, linePoints, gridLines };
  }, [monthlyTrend]);

  function filteredRows(): Transaction[] {
    return rows.filter(r =>
      activeFilters.every(key => {
        const val = filterValues[key];
        if (!val || val === "all") return true;
        if (key.startsWith("custom:")) {
          const name = key.slice("custom:".length);
          return (parseExtra(r.extra)[name] ?? "") === val;
        }
        const fieldDef = FILTER_FIELDS.find(f => f.key === key);
        if (!fieldDef) return true;
        return String(r[fieldDef.field]) === val;
      })
    );
  }

  function handleGenerate() {
    setEditMode(false);
    setSortState(null);
    setDeletingRowId(null);
    const data = filteredRows();
    if (data.length === 0) {
      setReport(null);
      return;
    }

    if (reportType === "topProducts") {
      const agg: Record<string, { qty: number; value: number }> = {};
      data.forEach(r => {
        agg[r.product] = agg[r.product] || { qty: 0, value: 0 };
        agg[r.product].qty += r.quantity;
        agg[r.product].value += r.total_value;
      });
      const list = Object.entries(agg).sort((a, b) => b[1].qty - a[1].qty);
      setReport({
        title: "Most purchased products",
        columns: ["Product", "Units", "Total value"],
        rows: list.map(([n, v]) => [n, v.qty, money(v.value)]),
        numericCols: [{ index: 1, format: "int" }, { index: 2, format: "money" }],
      });
    } else if (reportType === "topCustomers") {
      const agg: Record<string, { qty: number; value: number }> = {};
      data.forEach(r => {
        agg[r.customer] = agg[r.customer] || { qty: 0, value: 0 };
        agg[r.customer].qty += r.quantity;
        agg[r.customer].value += r.total_value;
      });
      const list = Object.entries(agg).sort((a, b) => b[1].value - a[1].value);
      setReport({
        title: "Customers by total spend",
        columns: ["Customer", "Total units", "Total spend"],
        rows: list.map(([n, v]) => [n, v.qty, money(v.value)]),
        numericCols: [{ index: 1, format: "int" }, { index: 2, format: "money" }],
      });
    } else if (reportType === "byMonth") {
      const agg: Record<string, number> = {};
      data.forEach(r => { const k = `${r.month} ${r.year}`; agg[k] = (agg[k] || 0) + r.total_value; });
      const list = Object.entries(agg).sort((a, b) => b[1] - a[1]);
      setReport({
        title: "Sales by month",
        columns: ["Month", "Total sales"],
        rows: list.map(([n, v]) => [n, money(v)]),
        numericCols: [{ index: 1, format: "money" }],
      });
    } else if (reportType === "none") {
      if (activeFilters.length === 0) {
        alert("Add at least one filter above first — \"None\" shows only the columns you've added as filters.");
        setReport(null);
        return;
      }
      const fieldDefs = activeFilters.map(key => FILTER_FIELDS.find(f => f.key === key)!);
      const numericCols = fieldDefs
        .map<NumericCol | null>((fd, idx) => {
          if (fd.key === "year") return { index: idx, format: "int" };
          if (!fd.key.startsWith("custom:")) return null;
          const cf = customFields.find(c => c.name === fd.label);
          return cf && cf.field_type === "number" ? { index: idx, format: "int" } : null;
        })
        .filter((c): c is NumericCol => c !== null);
      setReport({
        title: `Selected fields: ${fieldDefs.map(f => f.label).join(", ")}`,
        columns: fieldDefs.map(f => f.label),
        rows: data.map(r => fieldDefs.map(fd => {
          if (fd.key.startsWith("custom:")) return parseExtra(r.extra)[fd.key.slice("custom:".length)] ?? "";
          return r[fd.field] as string | number;
        })),
        numericCols,
        rowIds: data.map(r => r.id),
        fieldKeys: fieldDefs.map(f => f.key),
        allowAddRow: false,
      });
    } else {
      const list = [...data].sort((a, b) => b.total_value - a.total_value);
      const customCols = customFields.map(cf => cf.name);
      const numericCols: NumericCol[] = [
        { index: 4, format: "int" },
        { index: 5, format: "money" },
        ...customFields
          .map((cf, i): NumericCol | null => (cf.field_type === "number" ? { index: 6 + i, format: "int" } : null))
          .filter((c): c is NumericCol => c !== null),
      ];
      setReport({
        title: "Raw transaction list",
        columns: ["Product", "Customer", "Year", "Month", "Quantity", "Total value", ...customCols],
        rows: list.map(r => {
          const extra = parseExtra(r.extra);
          return [r.product, r.customer, r.year, r.month, r.quantity, money(r.total_value), ...customCols.map(c => extra[c] ?? "")];
        }),
        numericCols,
        rowIds: list.map(r => r.id),
        fieldKeys: ["product", "customer", "year", "month", "quantity", "total_value", ...customCols.map(c => `custom:${c}`)],
        allowAddRow: true,
      });
    }
  }

  async function handleExport() {
    if (!report) return;
    try {
      const path = await save({
        defaultPath: report.title.replace(/\s+/g, "_").toLowerCase() + ".xlsx",
        filters: [{ name: "Excel", extensions: ["xlsx"] }],
      });
      if (!path) return;
      const stringRows = report.rows.map(row => row.map(v => String(v)));
      if (displayTotals) {
        stringRows.push(displayTotals.map(v => String(v)));
      }
      const numericCols = report.numericCols?.map(({ index }) => index) ?? [];
      await invoke("export_report", { savePath: path, columns: report.columns, rows: stringRows, numericCols });
      alert("Exported successfully.");
    } catch (err) {
      alert(`Export failed: ${err}`);
    }
  }

  return (
    <div className="app">
      <style>{`
        *{box-sizing:border-box;}
        body{margin:0;}
        .app{display:flex; min-height:100vh; background:#0B1120; color:#E7ECF6; font-family:'Segoe UI',sans-serif; font-size:14px;}
        .sidebar{width:200px; background:#0E1728; border-right:1px solid #1A2540; padding:1.5rem 1rem; flex-shrink:0; display:flex; flex-direction:column;}
        .logo{font-weight:700; font-size:15px; padding-bottom:1.5rem; margin-bottom:1rem; border-bottom:1px solid #1A2540;}
        .logo span{color:#38BDF8;}
        .logo-img{width:24px; height:24px; border-radius:6px; vertical-align:middle; margin-right:8px;}
        .nav{display:flex; flex-direction:column; gap:2px;}
        .nav-item{padding:9px 10px; border-radius:6px; color:#8B98B4; font-size:13.5px; cursor:pointer;}
        .nav-item:hover{background:rgba(255,255,255,0.03); color:#E7ECF6;}
        .nav-item.active{background:#123049; color:#38BDF8;}
        .main{flex:1; padding:1.75rem 2rem 3rem; min-width:0;}
        .topbar{display:flex; align-items:flex-start; justify-content:space-between; margin-bottom:1.5rem;}
        .topbar h1{font-size:22px; margin:0;}
        .topbar .sub{font-size:13px; color:#8B98B4; margin-top:2px;}
        .btn{background:#111A2E; border:1px solid #22304A; color:#E7ECF6; font-size:12px; padding:8px 14px; border-radius:6px; cursor:pointer; margin-left:8px;}
        .btn:hover{border-color:#38BDF8; color:#38BDF8;}
        .metrics{display:grid; grid-template-columns:repeat(3,1fr); gap:12px; margin-bottom:1.5rem;}
        .card{background:#111A2E; border:1px solid #1A2540; border-radius:10px; padding:1rem 1.1rem;}
        .card .label{font-size:10.5px; color:#5C6885; text-transform:uppercase; margin-bottom:8px;}
        .card .value{font-size:19px; font-weight:700;}
        .card .sub{font-size:12px; color:#8B98B4; margin-top:4px;}
        .panel{background:#111A2E; border:1px solid #1A2540; border-radius:10px; padding:1.25rem 1.4rem; margin-bottom:1.25rem;}
        .panel-title{font-size:11px; font-weight:600; color:#8B98B4; text-transform:uppercase; margin-bottom:1rem;}
        .filter-grid{display:flex; flex-wrap:wrap; gap:12px; align-items:end;}
        .field{flex:1 1 160px; min-width:150px; position:relative;}
        .field label{display:flex; justify-content:space-between; font-size:11.5px; color:#5C6885; margin-bottom:6px;}
        .field .remove{cursor:pointer; color:#5C6885; font-size:11px;}
        .field .remove:hover{color:#F87171;}
        select{width:100%; height:38px; background:#0E1728; border:1px solid #22304A; border-radius:6px; color:#E7ECF6; padding:0 10px;}
        .apply-btn{height:38px; background:#38BDF8; border:none; color:#04202E; font-weight:700; font-size:12.5px; padding:0 18px; border-radius:6px; cursor:pointer;}
        .add-filter{flex:1 1 160px; min-width:150px;}
        .add-filter select{border-style:dashed;}
        .results{background:#111A2E; border:1px solid #1A2540; border-radius:10px; overflow:hidden;}
        .results-head{padding:1rem 1.4rem; border-bottom:1px solid #1A2540; display:flex; align-items:center; justify-content:space-between;}
        .results-head h2{font-size:13px; margin:0; text-transform:uppercase;}
        table{width:100%; border-collapse:collapse;}
        thead th{text-align:left; font-size:10.5px; text-transform:uppercase; color:#5C6885; padding:10px 1.4rem; border-bottom:1px solid #1A2540;}
        tbody td{padding:10px 1.4rem; border-bottom:1px solid #1A2540; font-size:13px;}
        .empty{padding:3rem; text-align:center; color:#5C6885;}
        .totals-row td{font-weight:700; border-top:2px solid #22304A; border-bottom:none; background:rgba(56,189,248,0.04);}
        .edit-input{width:100%; height:30px; background:#0E1728; border:1px solid #22304A; border-radius:5px; color:#E7ECF6; padding:0 8px; font-size:13px;}
        .manual-table{width:100%; border-collapse:collapse;}
        .manual-table th{text-align:left; font-size:10.5px; text-transform:uppercase; color:#5C6885; padding:8px 6px; border-bottom:1px solid #1A2540;}
        .manual-table td{padding:6px; border-bottom:1px solid #1A2540;}
        .manual-table input, .manual-table select{width:100%; height:34px; background:#0E1728; border:1px solid #22304A; border-radius:5px; color:#E7ECF6; padding:0 8px; font-size:13px;}
        .manual-table .remove{cursor:pointer; color:#5C6885; font-size:13px;}
        .manual-table .remove:hover{color:#F87171;}
        .modal-overlay{position:fixed; inset:0; background:rgba(0,0,0,0.6); display:flex; align-items:center; justify-content:center; z-index:50; padding:2rem;}
        .modal-panel{background:#111A2E; border:1px solid #1A2540; border-radius:10px; padding:1.5rem; max-width:760px; width:100%; max-height:80vh; overflow-y:auto;}
      `}</style>

      <div className="sidebar">
        <div className="logo"><img src="/icon.png" alt="" className="logo-img" />TRADE<span>PULSE</span></div>
        <div className="nav">
          <div className={`nav-item ${view === "dashboard" ? "active" : ""}`} onClick={() => setView("dashboard")}>Dashboard</div>
          <div className={`nav-item ${view === "trends" ? "active" : ""}`} onClick={() => setView("trends")}>Trends</div>
          <div className={`nav-item ${view === "sheet" ? "active" : ""}`} onClick={() => setView("sheet")}>Sheet</div>
        </div>
        <div className="nav" style={{ marginTop: "auto", paddingTop: "12px", borderTop: "1px solid #1A2540" }}>
          <div className={`nav-item ${view === "batches" ? "active" : ""}`} onClick={() => setView("batches")}>Batches</div>
        </div>
      </div>

      <div className="main">
        <datalist id="product-suggestions">
          {productSuggestions.map(v => <option key={v} value={v} />)}
        </datalist>
        <datalist id="customer-suggestions">
          {customerSuggestions.map(v => <option key={v} value={v} />)}
        </datalist>
        {customFields.filter(cf => cf.field_type !== "number").map(cf => (
          <datalist key={cf.name} id={`custom-suggestions-${cf.name}`}>
            {customFieldSuggestions(cf.name).map(v => <option key={v} value={v} />)}
          </datalist>
        ))}

        {showImportMapper && (
          <div className="modal-overlay">
            <div className="modal-panel">
              <div className="panel-title">Match this file's columns</div>
              <div className="sub" style={{ marginBottom: "14px" }}>
                Map each spreadsheet column. Product, Customer, Year, Month, Quantity, and Total Value are required.
              </div>
              {importHeaders.map((header, index) => {
                const mapping = importMappings[String(index)];
                if (!mapping) return null;
                return (
                  <div key={index} className="filter-grid" style={{ marginBottom: "10px" }}>
                    <div className="field" style={{ flex: "0 0 150px" }}>
                      <label>Spreadsheet column</label>
                      <div style={{ height: "38px", display: "flex", alignItems: "center", color: "#E7ECF6", fontSize: "13px" }}>{header}</div>
                    </div>
                    <div className="field">
                      <label>Maps to</label>
                      <select value={mapping.role} onChange={e => updateImportMapping(index, { role: e.target.value })}>
                        {STANDARD_ROLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </div>
                    {mapping.role === "custom" && (
                      <>
                        <div className="field">
                          <label>Field name</label>
                          <input value={mapping.fieldName} onChange={e => updateImportMapping(index, { fieldName: e.target.value })} />
                        </div>
                        <div className="field">
                          <label>Type</label>
                          <select value={mapping.fieldType} onChange={e => updateImportMapping(index, { fieldType: e.target.value as "text" | "number" })}>
                            <option value="text">Text</option>
                            <option value="number">Number</option>
                          </select>
                        </div>
                      </>
                    )}
                  </div>
                );
              })}
              <div style={{ marginTop: "14px", display: "flex", gap: "8px" }}>
                <button className="apply-btn" onClick={handleConfirmImport} disabled={importing}>{importing ? "Importing..." : "Import"}</button>
                <button className="btn" onClick={handleCancelImport} disabled={importing}>Cancel</button>
              </div>
            </div>
          </div>
        )}

        {view === "sheet" && (
          <Sheet
            rows={rows}
            customFields={customFields}
            refreshTransactions={loadData}
            refreshCustomFields={loadCustomFields}
          />
        )}

        {view === "batches" && openBatchId === null && (
          <Batches onOpenBatch={(id) => setOpenBatchId(id)} />
        )}

        {view === "batches" && openBatchId !== null && (
          <BatchDetail
            batchId={openBatchId}
            onBack={() => setOpenBatchId(null)}
            refreshTransactions={loadData}
          />
        )}

        {view === "trends" && (
          <>
            <div className="topbar">
              <div>
                <h1>Sales trends</h1>
                <div className="sub">Month-over-month growth analysis</div>
              </div>
            </div>

            {latestTrend && (
              <div className="metrics">
                <div className="card">
                  <div className="label">Latest month</div>
                  <div className="value">{latestTrend.month} {latestTrend.year}</div>
                  <div className="sub">Revenue: {money(latestTrend.value)}</div>
                </div>
                {previousTrend && (
                  <div className="card">
                    <div className="label">Previous month</div>
                    <div className="value">{previousTrend.month} {previousTrend.year}</div>
                    <div className="sub">Revenue: {money(previousTrend.value)}</div>
                  </div>
                )}
                {latestTrend.change !== null && (
                  <div className="card">
                    <div className="label">Change vs last month</div>
                    <div className="value" style={{ color: latestTrend.change >= 0 ? "#34D399" : "#F87171" }}>
                      {latestTrend.change >= 0 ? "+" : ""}{latestTrend.change.toFixed(1)}%
                    </div>
                    <div className="sub">{latestTrend.change >= 0 ? "Growth" : "Decline"} month-over-month</div>
                  </div>
                )}
              </div>
            )}

            <div className="panel">
              <div className="panel-title">Revenue trend</div>
              {trendChart ? (
                <svg viewBox={`0 0 ${TREND_CHART_WIDTH} ${TREND_CHART_HEIGHT}`} width="100%" height="240" preserveAspectRatio="xMidYMid meet">
                  {trendChart.gridLines.map((y, i) => (
                    <line key={i} x1={TREND_PADDING.left} y1={y} x2={TREND_CHART_WIDTH - TREND_PADDING.right} y2={y} stroke="#1A2540" strokeWidth="1" />
                  ))}
                  <polyline points={trendChart.linePoints} fill="none" stroke="#38BDF8" strokeWidth="2" />
                  {trendChart.points.map((p, i) => (
                    <g key={i}>
                      <circle cx={p.x} cy={p.y} r="3.5" fill="#38BDF8">
                        <title>{money(p.m.value)}</title>
                      </circle>
                      <text x={p.x} y={p.y - 12} fontSize="10" fill="#E7ECF6" textAnchor="middle">{compactMoney(p.m.value)}</text>
                      <text x={p.x} y={TREND_CHART_HEIGHT - 18} fontSize="10" fill="#8B98B4" textAnchor="middle">{p.m.month.slice(0, 3)} {String(p.m.year).slice(2)}</text>
                    </g>
                  ))}
                </svg>
              ) : (
                <div className="empty">Need at least 2 months of data to show a trend</div>
              )}
            </div>

            <div className="results">
              <div className="results-head">
                <h2>Month-over-month breakdown</h2>
              </div>
              {monthlyTrend.length > 0 ? (
                <table>
                  <thead>
                    <tr><th>Month</th><th>Revenue</th><th>Change vs previous</th></tr>
                  </thead>
                  <tbody>
                    {monthlyTrend.map((m, i) => (
                      <tr key={i}>
                        <td>{m.month} {m.year}</td>
                        <td>{money(m.value)}</td>
                        <td style={{ color: m.change === null ? "#5C6885" : m.change >= 0 ? "#34D399" : "#F87171" }}>
                          {m.change === null ? "—" : `${m.change >= 0 ? "+" : ""}${m.change.toFixed(1)}%`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div className="empty">No data yet</div>
              )}
            </div>
          </>
        )}

        {view === "dashboard" && (
          <>
            <div className="topbar">
              <div>
                <h1>Trader analytics dashboard</h1>
                <div className="sub">{loading ? "Loading..." : `${rows.length} transactions in database`}</div>
              </div>
              <div>
                <button className="btn" onClick={handleImport}>Import Excel File</button>
                <button className="btn" onClick={loadData}>Refresh</button>
                <button className="btn" onClick={handleClearData}>Clear Data</button>
              </div>
            </div>

            {metrics && (
              <div className="metrics">
                <div className="card">
                  <div className="label">Top selling product</div>
                  <div className="value">{metrics.topProduct[0]}</div>
                  <div className="sub">Volume: {metrics.topProduct[1].toLocaleString()} units</div>
                </div>
                <div className="card">
                  <div className="label">Highest-spending customer</div>
                  <div className="value">{metrics.topCustomer[0]}</div>
                  <div className="sub">Revenue: {money(metrics.topCustomer[1])}</div>
                </div>
                <div className="card">
                  <div className="label">Peak sales month</div>
                  <div className="value">{metrics.topMonth[0]}</div>
                  <div className="sub">Revenue: {money(metrics.topMonth[1])}</div>
                </div>
              </div>
            )}

            <div className="panel">
              <div className="panel-title" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>Custom analytics report generator</span>
                <span className="remove" style={{ cursor: "pointer" }} onClick={() => setShowNewFieldForm(!showNewFieldForm)}>
                  {showNewFieldForm ? "✕ cancel" : "+ Add your own field"}
                </span>
              </div>
              {renderCustomFieldsChips()}
              {showNewFieldForm && (
                <div className="filter-grid" style={{ marginBottom: "12px" }}>
                  <div className="field">
                    <label>Field name</label>
                    <input
                      value={newFieldName}
                      onChange={e => setNewFieldName(e.target.value)}
                      placeholder="e.g. Region, Salesperson"
                      style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }}
                    />
                  </div>
                  <div className="field">
                    <label>Type</label>
                    <select value={newFieldType} onChange={e => setNewFieldType(e.target.value)}>
                      <option value="text">Text</option>
                      <option value="number">Number</option>
                    </select>
                  </div>
                  <button className="apply-btn" onClick={handleAddCustomField}>Add field</button>
                </div>
              )}
              <div className="filter-grid">
                {activeFilters.map(key => {
                  const fieldDef = FILTER_FIELDS.find(f => f.key === key)!;
                  return (
                    <div className="field" key={key}>
                      <label>
                        {fieldDef.label}
                        <span className="remove" onClick={() => handleRemoveFilter(key)}>✕ remove</span>
                      </label>
                      <select
                        value={filterValues[key] || "all"}
                        onChange={e => setFilterValues({ ...filterValues, [key]: e.target.value })}
                      >
                        <option value="all">All {fieldDef.label.toLowerCase()}s</option>
                        {uniqueValues(key, fieldDef.field).map(v => <option key={v} value={v}>{v}</option>)}
                      </select>
                    </div>
                  );
                })}

                <div className="field">
                  <label>Report view</label>
                  <select value={reportType} onChange={e => setReportType(e.target.value)}>
                    <option value="log">Raw transaction list</option>
                    <option value="none">None (only selected filters)</option>
                    <option value="topProducts">Most purchased products</option>
                    <option value="topCustomers">Customers by total spend</option>
                    <option value="byMonth">Sales by month</option>
                  </select>
                </div>

                {availableToAdd.length > 0 && (
                  <div className="add-filter">
                    <label>&nbsp;</label>
                    <select value="" onChange={e => handleAddFilter(e.target.value)}>
                      <option value="">+ Add filter</option>
                      {availableToAdd.map(f => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </div>
                )}

                <button className="apply-btn" onClick={handleGenerate}>Generate</button>
                <button className="btn" onClick={handleClearFilters}>Clear Filters</button>
              </div>
            </div>

            <div className="results">
              <div className="results-head">
                <h2>{report ? report.title : "Generated view"}</h2>
                {report && (
                  <div>
                    {report.fieldKeys && report.rowIds && report.rowIds.length === report.rows.length && (
                      <>
                        {editMode && report.allowAddRow && <button className="btn" onClick={addReportRow}>+ Add Row</button>}
                        <button className="btn" onClick={handleToggleEdit} disabled={savingEdits}>
                          {savingEdits ? "Saving..." : editMode ? "Done Editing" : "Edit Data"}
                        </button>
                      </>
                    )}
                    <button className="btn" onClick={handleExport}>Export .xlsx</button>
                  </div>
                )}
              </div>
              {report ? (
                <table>
                  <thead>
                    <tr>
                      {report.columns.map((c, idx) => (
                        <th
                          key={c}
                          onClick={() => { if (!editMode) handleSort(idx); }}
                          style={{ cursor: editMode ? "default" : "pointer", userSelect: "none" }}
                          title={editMode ? undefined : "Click to sort"}
                        >
                          {c}{sortState && sortState.index === idx ? (sortState.dir === "asc" ? " ▲" : " ▼") : ""}
                        </th>
                      ))}
                      {editMode && report.fieldKeys && report.rowIds && report.rowIds.length === report.rows.length && <th></th>}
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((r, i) => {
                      const canEdit = !!(report.fieldKeys && report.rowIds && report.rowIds.length === report.rows.length);
                      return (
                        <tr key={i}>
                          {r.map((val, j) => {
                            const isNumericCol = report.numericCols?.some(c => c.index === j) ?? false;
                            const fieldKey = report.fieldKeys?.[j];

                            if (editMode && canEdit && fieldKey === "product") {
                              return (
                                <td key={j}>
                                  <input className="edit-input" list="product-suggestions" value={String(val)} onChange={e => updateReportCell(i, j, e.target.value)} placeholder="e.g. Laptop Pro 15" />
                                </td>
                              );
                            }
                            if (editMode && canEdit && fieldKey === "customer") {
                              return (
                                <td key={j}>
                                  <input className="edit-input" list="customer-suggestions" value={String(val)} onChange={e => updateReportCell(i, j, e.target.value)} placeholder="e.g. TechCorp Ghana" />
                                </td>
                              );
                            }
                            if (editMode && canEdit && fieldKey === "month") {
                              return (
                                <td key={j}>
                                  <select className="edit-input" value={String(val)} onChange={e => updateReportCell(i, j, e.target.value)}>
                                    <option value="">Select month</option>
                                    {MONTH_ORDER.map(m => <option key={m} value={m}>{m}</option>)}
                                  </select>
                                </td>
                              );
                            }
                            if (editMode && canEdit && fieldKey?.startsWith("custom:")) {
                              const name = fieldKey.slice("custom:".length);
                              const cf = customFields.find(c => c.name === name);
                              if (cf && cf.field_type !== "number") {
                                return (
                                  <td key={j}>
                                    <input className="edit-input" list={`custom-suggestions-${name}`} value={String(val)} onChange={e => updateReportCell(i, j, e.target.value)} />
                                  </td>
                                );
                              }
                            }

                            return (
                              <td key={j}>
                                {editMode ? (
                                  <input
                                    className="edit-input"
                                    inputMode={isNumericCol ? "decimal" : "text"}
                                    value={String(val)}
                                    onChange={e => updateReportCell(i, j, isNumericCol ? sanitizeNumericInput(e.target.value) : e.target.value)}
                                  />
                                ) : val}
                              </td>
                            );
                          })}
                          {editMode && canEdit && (
                            <td>
                              <span
                                className="remove"
                                style={deletingRowId === report.rowIds![i] ? { opacity: 0.4, pointerEvents: "none" } : undefined}
                                onClick={() => removeReportRow(i)}
                              >
                                {deletingRowId === report.rowIds![i] ? "…" : "✕"}
                              </span>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                    {displayTotals && (
                      <tr className="totals-row">
                        {displayTotals.map((val, j) => <td key={j}>{val}</td>)}
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <div className="empty">— set filters above and click Generate —</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default App;

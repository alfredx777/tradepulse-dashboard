import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

const MONTH_ORDER = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

interface BatchDetails {
  id: number;
  batch_number: string;
  batch_date: string;
  supplier: string;
}

interface BatchItem {
  id: number;
  batch_id: number;
  seq_in_batch: number;
  item_code: string;
  name: string;
  size: string;
  price: number;
  initial_quantity: number;
  quantity_remaining: number;
}

interface BatchDetailProps {
  batchId: number;
  onBack: () => void;
  refreshTransactions: () => Promise<void>;
}

function fmtPrice(n: number): string {
  return n.toFixed(2);
}

export default function BatchDetail({ batchId, onBack, refreshTransactions }: BatchDetailProps) {
  const [batch, setBatch] = useState<BatchDetails | null>(null);
  const [items, setItems] = useState<BatchItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const [showAddItem, setShowAddItem] = useState(false);
  const [newItemName, setNewItemName] = useState("");
  const [newItemSize, setNewItemSize] = useState("");
  const [newItemPrice, setNewItemPrice] = useState("");
  const [newItemQty, setNewItemQty] = useState("");
  const [addingItem, setAddingItem] = useState(false);

  const [actionItem, setActionItem] = useState<BatchItem | null>(null);
  const [actionMode, setActionMode] = useState<"sell" | "return">("sell");
  const [actionQty, setActionQty] = useState("");
  const [actionCustomer, setActionCustomer] = useState("");
  const [actionYear, setActionYear] = useState(String(new Date().getFullYear()));
  const [actionMonth, setActionMonth] = useState("");
  const [actionSaving, setActionSaving] = useState(false);

  const [removingItemId, setRemovingItemId] = useState<number | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletingBatch, setDeletingBatch] = useState(false);

  async function loadBatch() {
    setLoading(true);
    try {
      const [b, its] = await Promise.all([
        invoke<BatchDetails>("get_batch", { batchId }),
        invoke<BatchItem[]>("get_batch_items", { batchId }),
      ]);
      setBatch(b);
      setItems(its);
    } catch (err) {
      alert(`Failed to load batch: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadBatch(); }, [batchId]);

  async function handleAddItem() {
    if (!newItemName.trim()) { alert("Enter an item name."); return; }
    const confirmed = window.confirm("Add this item to the saved batch?");
    if (!confirmed) return;
    setAddingItem(true);
    try {
      await invoke("add_batch_item", {
        batchId,
        name: newItemName.trim(),
        size: newItemSize.trim(),
        price: parseFloat(newItemPrice) || 0,
        quantity: parseInt(newItemQty, 10) || 0,
      });
      setNewItemName(""); setNewItemSize(""); setNewItemPrice(""); setNewItemQty("");
      setShowAddItem(false);
      await loadBatch();
    } catch (err) {
      alert(`Failed to add item: ${err}`);
    } finally {
      setAddingItem(false);
    }
  }

  async function handleRemoveItem(item: BatchItem) {
    const confirmed = window.confirm(`Remove "${item.name}" (${item.item_code}) from this batch? This cannot be undone.`);
    if (!confirmed) return;
    setRemovingItemId(item.id);
    try {
      await invoke("delete_batch_item", { itemId: item.id });
      await loadBatch();
    } catch (err) {
      alert(`Failed to remove item: ${err}`);
    } finally {
      setRemovingItemId(null);
    }
  }

  function openAction(item: BatchItem, mode: "sell" | "return") {
    setActionItem(item);
    setActionMode(mode);
    setActionQty("");
    setActionCustomer("");
    setActionYear(String(new Date().getFullYear()));
    setActionMonth("");
  }

  async function handleConfirmAction() {
    if (!actionItem) return;
    const qty = parseInt(actionQty, 10);
    if (!qty || qty <= 0) { alert("Enter a quantity greater than zero."); return; }
    if (!actionCustomer.trim()) { alert("Enter a customer name."); return; }
    if (!actionMonth) { alert("Select a month."); return; }
    const confirmed = window.confirm(
      `${actionMode === "sell" ? "Sell" : "Return"} ${qty} unit(s) of "${actionItem.name}" ${actionMode === "sell" ? "to" : "from"} ${actionCustomer.trim()}?`
    );
    if (!confirmed) return;

    setActionSaving(true);
    try {
      await invoke("record_batch_sale", {
        batchItemId: actionItem.id,
        customer: actionCustomer.trim(),
        quantity: qty,
        isReturn: actionMode === "return",
        year: parseInt(actionYear, 10) || new Date().getFullYear(),
        month: actionMonth,
      });
      setActionItem(null);
      await loadBatch();
      await refreshTransactions();
    } catch (err) {
      alert(`Failed: ${err}`);
    } finally {
      setActionSaving(false);
    }
  }

  function handleDeleteBatchClick() {
    const confirmed = window.confirm("Are you sure you want to delete this entire batch? This cannot be undone.");
    if (!confirmed) return;
    setShowDeleteConfirm(true);
    setDeleteConfirmText("");
  }

  async function handleConfirmDeleteBatch() {
    if (!batch) return;
    if (deleteConfirmText.trim().toLowerCase() !== batch.batch_number.trim().toLowerCase()) {
      alert("Batch number doesn't match.");
      return;
    }
    setDeletingBatch(true);
    try {
      await invoke("delete_batch", { batchId: batch.id, confirmBatchNumber: deleteConfirmText.trim() });
      onBack();
    } catch (err) {
      alert(`Failed to delete batch: ${err}`);
    } finally {
      setDeletingBatch(false);
    }
  }

  const filteredItems = items.filter(i =>
    i.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    i.item_code.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <>
      <style>{`
        .batchdetail-search{width:280px; height:38px; background:#0E1728; border:1px solid #22304A; border-radius:6px; color:#E7ECF6; padding:0 12px;}
        .batchdetail-actions{display:flex; gap:6px;}
        .batchdetail-actions .btn{margin-left:0; padding:6px 10px; font-size:11.5px;}
      `}</style>

      <div className="topbar">
        <div>
          <span onClick={onBack} style={{ cursor: "pointer", color: "#38BDF8", fontSize: "12.5px" }}>← All batches</span>
          <h1 style={{ marginTop: "6px" }}>{loading ? "Loading..." : batch?.batch_number}</h1>
          <div className="sub">
            {batch && `${batch.batch_date || "No date"} · ${batch.supplier || "No supplier"}`}
          </div>
        </div>
        <div>
          <button className="btn" onClick={() => setShowAddItem(!showAddItem)}>{showAddItem ? "✕ Cancel" : "+ Add Item"}</button>
          <button className="btn" style={{ borderColor: "#F87171", color: "#F87171" }} onClick={handleDeleteBatchClick}>Delete Batch</button>
        </div>
      </div>

      {showAddItem && (
        <div className="panel">
          <div className="panel-title">Add item to this batch</div>
          <div className="filter-grid">
            <div className="field">
              <label>Name</label>
              <input value={newItemName} onChange={e => setNewItemName(e.target.value)}
                style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
            </div>
            <div className="field">
              <label>Size</label>
              <input value={newItemSize} onChange={e => setNewItemSize(e.target.value)}
                style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
            </div>
            <div className="field">
              <label>Price</label>
              <input type="text" inputMode="decimal" value={newItemPrice} onChange={e => setNewItemPrice(e.target.value)}
                style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
            </div>
            <div className="field">
              <label>Quantity</label>
              <input type="text" inputMode="numeric" value={newItemQty} onChange={e => setNewItemQty(e.target.value)}
                style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
            </div>
            <button className="apply-btn" onClick={handleAddItem} disabled={addingItem}>{addingItem ? "Adding..." : "Add"}</button>
          </div>
        </div>
      )}

      {showDeleteConfirm && batch && (
        <div className="modal-overlay">
          <div className="modal-panel">
            <div className="panel-title">Confirm batch deletion</div>
            <div className="sub" style={{ marginBottom: "14px" }}>
              This permanently deletes batch <strong>{batch.batch_number}</strong> and all its items. Past sales stay in your records, but will no longer be linked to this batch. Type the batch number below to confirm.
            </div>
            <input
              value={deleteConfirmText}
              onChange={e => setDeleteConfirmText(e.target.value)}
              placeholder={batch.batch_number}
              style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px", marginBottom: "14px" }}
            />
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="apply-btn" style={{ background: "#F87171" }} onClick={handleConfirmDeleteBatch} disabled={deletingBatch}>
                {deletingBatch ? "Deleting..." : "Permanently Delete"}
              </button>
              <button className="btn" onClick={() => setShowDeleteConfirm(false)} disabled={deletingBatch}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {actionItem && (
        <div className="modal-overlay">
          <div className="modal-panel">
            <div className="panel-title">{actionMode === "sell" ? "Sell" : "Return"} — {actionItem.name} ({actionItem.item_code})</div>
            <div className="filter-grid" style={{ marginBottom: "14px" }}>
              <div className="field">
                <label>Quantity</label>
                <input type="text" inputMode="numeric" value={actionQty} onChange={e => setActionQty(e.target.value)}
                  style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
              </div>
              <div className="field">
                <label>Customer</label>
                <input value={actionCustomer} onChange={e => setActionCustomer(e.target.value)}
                  style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
              </div>
              <div className="field">
                <label>Year</label>
                <input type="text" inputMode="numeric" value={actionYear} onChange={e => setActionYear(e.target.value)}
                  style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
              </div>
              <div className="field">
                <label>Month</label>
                <select value={actionMonth} onChange={e => setActionMonth(e.target.value)}>
                  <option value="">Select month</option>
                  {MONTH_ORDER.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button className="apply-btn" onClick={handleConfirmAction} disabled={actionSaving}>
                {actionSaving ? "Saving..." : "Confirm"}
              </button>
              <button className="btn" onClick={() => setActionItem(null)} disabled={actionSaving}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <input
          className="batchdetail-search"
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Search items by name or code..."
        />
      </div>

      <div className="results">
        <div className="results-head">
          <h2>Items ({filteredItems.length})</h2>
        </div>
        {filteredItems.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Item code</th><th>Name</th><th>Size</th><th>Price</th><th>Remaining / Initial</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map(item => (
                <tr key={item.id}>
                  <td>{item.item_code}</td>
                  <td>{item.name}</td>
                  <td>{item.size || "—"}</td>
                  <td>{fmtPrice(item.price)}</td>
                  <td>{item.quantity_remaining} / {item.initial_quantity}</td>
                  <td>
                    <div className="batchdetail-actions">
                      <button className="btn" onClick={() => openAction(item, "sell")} disabled={item.quantity_remaining <= 0}>Sell</button>
                      <button className="btn" onClick={() => openAction(item, "return")}>Return</button>
                      <span
                        className="remove"
                        style={removingItemId === item.id ? { opacity: 0.4, pointerEvents: "none" } : undefined}
                        onClick={() => handleRemoveItem(item)}
                      >
                        {removingItemId === item.id ? "…" : "✕"}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty">{items.length === 0 ? "No items in this batch." : "No items match your search."}</div>
        )}
      </div>
    </>
  );
}
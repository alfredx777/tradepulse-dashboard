import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

interface BatchSummary {
  id: number;
  batch_number: string;
  batch_date: string;
  supplier: string;
  item_count: number;
  total_remaining: number;
}

interface BatchItemRow {
  name: string;
  size: string;
  price: string;
  quantity: string;
}

const emptyItemRow = (): BatchItemRow => ({ name: "", size: "", price: "", quantity: "" });

interface BatchesProps {
  onOpenBatch: (batchId: number) => void;
}

export default function Batches({ onOpenBatch }: BatchesProps) {
  const [batches, setBatches] = useState<BatchSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewBatchForm, setShowNewBatchForm] = useState(false);

  const [batchNumber, setBatchNumber] = useState("");
  const [batchDate, setBatchDate] = useState("");
  const [supplier, setSupplier] = useState("");
  const [itemRows, setItemRows] = useState<BatchItemRow[]>([emptyItemRow()]);
  const [creating, setCreating] = useState(false);

  async function loadBatches() {
    setLoading(true);
    try {
      const data = await invoke<BatchSummary[]>("get_batches");
      setBatches(data);
    } catch (err) {
      alert(`Failed to load batches: ${err}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBatches();
  }, []);

  function updateItemRow(index: number, field: keyof BatchItemRow, value: string) {
    const next = [...itemRows];
    next[index] = { ...next[index], [field]: value };
    setItemRows(next);
  }
  function addItemRow() {
    setItemRows([...itemRows, emptyItemRow()]);
  }
  function removeItemRow(index: number) {
    setItemRows(itemRows.filter((_, i) => i !== index));
  }

  function resetForm() {
    setBatchNumber("");
    setBatchDate("");
    setSupplier("");
    setItemRows([emptyItemRow()]);
  }

  async function handleCreateBatch() {
    if (!batchNumber.trim()) { alert("Enter a batch number."); return; }
    const valid = itemRows.filter(r => r.name.trim() !== "");
    if (valid.length === 0) { alert("Add at least one item."); return; }

    const parsedItems = valid.map(r => ({
      name: r.name.trim(),
      size: r.size.trim(),
      price: parseFloat(r.price) || 0,
      quantity: parseInt(r.quantity, 10) || 0,
    }));

    setCreating(true);
    try {
      await invoke<number>("create_batch", {
        batchNumber: batchNumber.trim(),
        batchDate,
        supplier,
        items: parsedItems,
      });
      alert("Batch created.");
      resetForm();
      setShowNewBatchForm(false);
      await loadBatches();
    } catch (err) {
      alert(`Failed to create batch: ${err}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <style>{`
        .batch-list{display:flex; flex-direction:column; gap:2px;}
        .batch-row{display:grid; grid-template-columns:1.5fr 1fr 1fr 1fr; gap:12px; padding:12px 1.4rem; border-bottom:1px solid #1A2540; cursor:pointer; align-items:center;}
        .batch-row:hover{background:rgba(56,189,248,0.06);}
        .batch-row .num{font-weight:600; color:#E7ECF6;}
        .batch-row .meta{font-size:12.5px; color:#8B98B4;}
      `}</style>

      <div className="topbar">
        <div>
          <h1>Batches</h1>
          <div className="sub">{loading ? "Loading..." : `${batches.length} batch${batches.length === 1 ? "" : "es"}`}</div>
        </div>
        <div>
          <button className="btn" onClick={loadBatches}>Refresh</button>
          <button className="apply-btn" onClick={() => setShowNewBatchForm(!showNewBatchForm)} style={{ marginLeft: "8px" }}>
            {showNewBatchForm ? "✕ Cancel" : "+ New Batch"}
          </button>
        </div>
      </div>

      {showNewBatchForm && (
        <div className="panel">
          <div className="panel-title">New batch</div>
          <div className="filter-grid" style={{ marginBottom: "16px" }}>
            <div className="field">
              <label>Batch number</label>
              <input value={batchNumber} onChange={e => setBatchNumber(e.target.value)} placeholder="e.g. B2024-01"
                style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
            </div>
            <div className="field">
              <label>Date received</label>
              <input type="date" value={batchDate} onChange={e => setBatchDate(e.target.value)}
                style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
            </div>
            <div className="field">
              <label>Supplier</label>
              <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="e.g. Guangzhou Textiles Co."
                style={{ width: "100%", height: "38px", background: "#0E1728", border: "1px solid #22304A", borderRadius: "6px", color: "#E7ECF6", padding: "0 10px" }} />
            </div>
          </div>

          <div className="panel-title">Items in this batch</div>
          <table className="manual-table">
            <thead>
              <tr><th>Name</th><th>Size</th><th>Price</th><th>Quantity</th><th></th></tr>
            </thead>
            <tbody>
              {itemRows.map((row, i) => (
                <tr key={i}>
                  <td><input value={row.name} onChange={e => updateItemRow(i, "name", e.target.value)} placeholder="e.g. Sneaker" /></td>
                  <td><input value={row.size} onChange={e => updateItemRow(i, "size", e.target.value)} placeholder="e.g. Medium" /></td>
                  <td><input type="text" inputMode="decimal" value={row.price} onChange={e => updateItemRow(i, "price", e.target.value)} placeholder="0.00" /></td>
                  <td><input type="text" inputMode="numeric" value={row.quantity} onChange={e => updateItemRow(i, "quantity", e.target.value)} placeholder="0" /></td>
                  <td><span className="remove" onClick={() => removeItemRow(i)}>✕</span></td>
                </tr>
              ))}
            </tbody>
          </table>

          <div style={{ marginTop: "14px", display: "flex", gap: "8px" }}>
            <button className="btn" onClick={addItemRow}>+ Add Item</button>
            <button className="apply-btn" onClick={handleCreateBatch} disabled={creating}>
              {creating ? "Saving..." : "Save Batch"}
            </button>
          </div>
        </div>
      )}

      <div className="results">
        <div className="results-head">
          <h2>All batches</h2>
        </div>
        {batches.length > 0 ? (
          <div className="batch-list">
            {batches.map(b => (
              <div key={b.id} className="batch-row" onClick={() => onOpenBatch(b.id)}>
                <div className="num">{b.batch_number}</div>
                <div className="meta">{b.batch_date || "No date"}</div>
                <div className="meta">{b.supplier || "No supplier"}</div>
                <div className="meta">{b.item_count} item{b.item_count === 1 ? "" : "s"} · {b.total_remaining} in stock</div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty">No batches yet — click "+ New Batch" to create one.</div>
        )}
      </div>
    </>
  );
}
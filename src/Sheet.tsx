import { useState, useEffect, useMemo, useRef } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import type { Transaction, CustomField } from "./types";
import { guessRole, STANDARD_ROLE_OPTIONS, type ImportMapping } from "./importMapping";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts";
import { useUndoRedo } from "./hooks/useUndoRedo";

const SHEET_ROWS = 30;
const SHEET_COLS = 10;
function colLetter(c: number): string {
  let n = c + 1;
  let s = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function parseColLetter(s: string): number | null {
  const clean = s.trim().toUpperCase();
  if (!/^[A-Z]+$/.test(clean)) return null;
  let n = 0;
  for (const ch of clean) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function cellLabel(r: number, c: number): string {
  return colLetter(c) + String(r + 1);
}

type SheetArg =
  | { kind: "range"; values: string[]; numRows: number; numCols: number }
  | { kind: "cell"; value: string; cellId: string }
  | { kind: "text"; value: string };

interface SheetArgSpec {
  kind: "range" | "cell" | "text";
  label: string;
}

interface SheetFunctionDef {
  name: string;
  category: string;
  args: SheetArgSpec[];
  compute: (args: SheetArg[]) => string;
}

function numOf(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

type FormulaArgSpec =
  | { kind: "range"; r1: number; c1: number; r2: number; c2: number }
  | { kind: "cell"; r: number; c: number }
  | { kind: "text"; value: string };

interface SheetFormula {
  fnName: string;
  args: FormulaArgSpec[];
}

function formulaArgLabel(spec: FormulaArgSpec): string {
  if (spec.kind === "range") {
    const r1 = Math.min(spec.r1, spec.r2), r2 = Math.max(spec.r1, spec.r2);
    const c1 = Math.min(spec.c1, spec.c2), c2 = Math.max(spec.c1, spec.c2);
    return r1 === r2 && c1 === c2 ? cellLabel(r1, c1) : `${cellLabel(r1, c1)}:${cellLabel(r2, c2)}`;
  }
  if (spec.kind === "cell") return cellLabel(spec.r, spec.c);
  return JSON.stringify(spec.value);
}

function formulaText(formula: SheetFormula): string {
  return `=${formula.fnName}(${formula.args.map(formulaArgLabel).join(", ")})`;
}

// Recomputes every formula cell's value from its stored refs, resolving formula-to-formula
// chains (with cycle protection) so results stay live as the raw cells they depend on change.
function computeDisplayGrid(cells: Record<string, string>, formulas: Record<string, SheetFormula>): Record<string, string> {
  const cache: Record<string, string> = {};
  const inProgress = new Set<string>();

  function resolveSpec(spec: FormulaArgSpec): SheetArg {
    if (spec.kind === "text") return { kind: "text", value: spec.value };
    if (spec.kind === "cell") return { kind: "cell", value: getValue(`R${spec.r}C${spec.c}`), cellId: cellLabel(spec.r, spec.c) };
    const r1 = Math.min(spec.r1, spec.r2), r2 = Math.max(spec.r1, spec.r2);
    const c1 = Math.min(spec.c1, spec.c2), c2 = Math.max(spec.c1, spec.c2);
    const values: string[] = [];
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) values.push(getValue(`R${r}C${c}`));
    return { kind: "range", values, numRows: r2 - r1 + 1, numCols: c2 - c1 + 1 };
  }

  function getValue(key: string): string {
    if (key in cache) return cache[key];
    const formula = formulas[key];
    if (!formula) {
      const val = cells[key] ?? "";
      cache[key] = val;
      return val;
    }
    if (inProgress.has(key)) return "#CIRCULAR!";
    inProgress.add(key);
    const def = FUNCTION_DEFS.find(f => f.name === formula.fnName);
    let result = "#ERROR!";
    if (def) {
      try {
        result = def.compute(formula.args.map(resolveSpec));
      } catch {
        result = "Error";
      }
    }
    inProgress.delete(key);
    cache[key] = result;
    return result;
  }

  new Set([...Object.keys(cells), ...Object.keys(formulas)]).forEach(key => { getValue(key); });
  return cache;
}

const FUNCTION_DEFS: SheetFunctionDef[] = [
  {
    name: "SUM", category: "Basic",
    args: [{ kind: "range", label: "Select the range to sum" }],
    compute: (a) => {
      const r = a[0] as { values: string[] };
      return String(r.values.reduce((s, v) => s + (Number.isFinite(numOf(v)) ? numOf(v) : 0), 0));
    },
  },
  {
    name: "AVERAGE", category: "Basic",
    args: [{ kind: "range", label: "Select the range to average" }],
    compute: (a) => {
      const r = a[0] as { values: string[] };
      const nums = r.values.map(numOf).filter(Number.isFinite);
      if (nums.length === 0) return "0";
      return String(nums.reduce((s, v) => s + v, 0) / nums.length);
    },
  },
  {
    name: "COUNT", category: "Basic",
    args: [{ kind: "range", label: "Select the range to count numbers in" }],
    compute: (a) => {
      const r = a[0] as { values: string[] };
      return String(r.values.filter(v => Number.isFinite(numOf(v))).length);
    },
  },
  {
    name: "COUNTA", category: "Basic",
    args: [{ kind: "range", label: "Select the range to count non-empty cells in" }],
    compute: (a) => {
      const r = a[0] as { values: string[] };
      return String(r.values.filter(v => v.trim() !== "").length);
    },
  },
  {
    name: "MIN", category: "Basic",
    args: [{ kind: "range", label: "Select the range" }],
    compute: (a) => {
      const r = a[0] as { values: string[] };
      const nums = r.values.map(numOf).filter(Number.isFinite);
      return nums.length ? String(Math.min(...nums)) : "0";
    },
  },
  {
    name: "MAX", category: "Basic",
    args: [{ kind: "range", label: "Select the range" }],
    compute: (a) => {
      const r = a[0] as { values: string[] };
      const nums = r.values.map(numOf).filter(Number.isFinite);
      return nums.length ? String(Math.max(...nums)) : "0";
    },
  },
  {
    name: "IF", category: "Logic",
    args: [
      { kind: "cell", label: "Select the cell to check" },
      { kind: "text", label: "Operator: =, >, <, >=, <=, or <>" },
      { kind: "text", label: "Compare to this value" },
      { kind: "text", label: "Value if TRUE" },
      { kind: "text", label: "Value if FALSE" },
    ],
    compute: (a) => {
      const cell = a[0] as { value: string };
      const op = (a[1] as { value: string }).value.trim();
      const compare = (a[2] as { value: string }).value;
      const whenTrue = (a[3] as { value: string }).value;
      const whenFalse = (a[4] as { value: string }).value;
      const cn = numOf(cell.value), pn = numOf(compare);
      const bothNumeric = Number.isFinite(cn) && Number.isFinite(pn);
      let result: boolean;
      switch (op) {
        case "=": result = bothNumeric ? cn === pn : cell.value === compare; break;
        case "<>": result = bothNumeric ? cn !== pn : cell.value !== compare; break;
        case ">": result = bothNumeric && cn > pn; break;
        case "<": result = bothNumeric && cn < pn; break;
        case ">=": result = bothNumeric && cn >= pn; break;
        case "<=": result = bothNumeric && cn <= pn; break;
        default: return "Error: unknown operator";
      }
      return result ? whenTrue : whenFalse;
    },
  },
  {
    name: "SUMIF", category: "Conditional",
    args: [
      { kind: "range", label: "Select the range to sum" },
      { kind: "range", label: "Select the criteria range (same size)" },
      { kind: "text", label: "Criteria value to match" },
    ],
    compute: (a) => {
      const sumRange = a[0] as { values: string[] };
      const criteriaRange = a[1] as { values: string[] };
      const criteria = (a[2] as { value: string }).value.trim().toLowerCase();
      if (sumRange.values.length !== criteriaRange.values.length) return "Error: ranges must be the same size";
      let total = 0;
      criteriaRange.values.forEach((v, i) => {
        if (v.trim().toLowerCase() === criteria) total += numOf(sumRange.values[i]) || 0;
      });
      return String(total);
    },
  },
  {
    name: "COUNTIF", category: "Conditional",
    args: [
      { kind: "range", label: "Select the range" },
      { kind: "text", label: "Criteria value to match" },
    ],
    compute: (a) => {
      const range = a[0] as { values: string[] };
      const criteria = (a[1] as { value: string }).value.trim().toLowerCase();
      return String(range.values.filter(v => v.trim().toLowerCase() === criteria).length);
    },
  },
  {
    name: "VLOOKUP", category: "Lookup",
    args: [
      { kind: "cell", label: "Select the lookup value cell" },
      { kind: "range", label: "Select the table range (first column is searched)" },
      { kind: "text", label: "Column number to return (1 = first column)" },
    ],
    compute: (a) => {
      const lookup = (a[0] as { value: string }).value.trim().toLowerCase();
      const table = a[1] as { values: string[]; numRows: number; numCols: number };
      const colIdx = parseInt((a[2] as { value: string }).value, 10) - 1;
      if (!Number.isInteger(colIdx) || colIdx < 0 || colIdx >= table.numCols) return "Error: invalid column number";
      for (let row = 0; row < table.numRows; row++) {
        if (table.values[row * table.numCols].trim().toLowerCase() === lookup) {
          return table.values[row * table.numCols + colIdx];
        }
      }
      return "#N/A";
    },
  },
  {
    name: "XLOOKUP", category: "Lookup",
    args: [
      { kind: "cell", label: "Select the lookup value cell" },
      { kind: "range", label: "Select the lookup range" },
      { kind: "range", label: "Select the return range (same size)" },
    ],
    compute: (a) => {
      const lookup = (a[0] as { value: string }).value.trim().toLowerCase();
      const lookupRange = a[1] as { values: string[] };
      const returnRange = a[2] as { values: string[] };
      if (lookupRange.values.length !== returnRange.values.length) return "Error: ranges must be the same size";
      const idx = lookupRange.values.findIndex(v => v.trim().toLowerCase() === lookup);
      return idx === -1 ? "#N/A" : returnRange.values[idx];
    },
  },
];

interface SheetProps {
  rows: Transaction[];
  customFields: CustomField[];
  refreshTransactions: () => Promise<void>;
  refreshCustomFields: () => Promise<void>;
}

export default function Sheet({ rows, customFields, refreshTransactions, refreshCustomFields }: SheetProps) {
  const [numRows, setNumRows] = useState(SHEET_ROWS);
  const [numCols, setNumCols] = useState(SHEET_COLS);
  const [sheetCells, setSheetCells] = useState<Record<string, string>>({});
  const [sheetSelection, setSheetSelection] = useState<{ r1: number; c1: number; r2: number; c2: number } | null>(null);
  const [editingCell, setEditingCell] = useState<{ r: number; c: number } | null>(null);
  const [editingValue, setEditingValue] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [dragMode, setDragMode] = useState<"cell" | "row" | "column">("cell");
  const [nameBoxInput, setNameBoxInput] = useState("");
  const [nameBoxEditing, setNameBoxEditing] = useState(false);
  const [sheetFormulas, setSheetFormulas] = useState<Record<string, SheetFormula>>({});
  const [sheetRowIds, setSheetRowIds] = useState<Record<number, number>>({});
  const displayGrid = useMemo(() => computeDisplayGrid(sheetCells, sheetFormulas), [sheetCells, sheetFormulas]);

  useEffect(() => {
    if (!nameBoxEditing) setNameBoxInput(selectionLabel());
  }, [sheetSelection, nameBoxEditing]);
  const [activeFunction, setActiveFunction] = useState<SheetFunctionDef | null>(null);
  const [wizardStepIndex, setWizardStepIndex] = useState(0);
  const [collectedArgs, setCollectedArgs] = useState<FormulaArgSpec[]>([]);
  const [wizardTextValue, setWizardTextValue] = useState("");

  useEffect(() => {
    function onWindowMouseUp() {
      setIsDragging(false);
      if (activeFunction && wizardStepIndex < activeFunction.args.length && activeFunction.args[wizardStepIndex].kind !== "text" && sheetSelection) {
        confirmWizardStep();
      }
    }
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, [activeFunction, wizardStepIndex, sheetSelection]);

  const clipboardRef = useRef<{ values: Record<string, string>; r1: number; c1: number; r2: number; c2: number; cut: boolean } | null>(null);
  const undoRedo = useUndoRedo<{ cells: Record<string, string>; formulas: Record<string, SheetFormula> }>({ cells: {}, formulas: {} });

  function applyGridChange(nextCells: Record<string, string>, nextFormulas: Record<string, SheetFormula>) {
    undoRedo.push({ cells: nextCells, formulas: nextFormulas });
    setSheetCells(nextCells);
    setSheetFormulas(nextFormulas);
  }

  function handleUndo() {
    const snap = undoRedo.undo();
    if (!snap) return;
    setSheetCells(snap.cells);
    setSheetFormulas(snap.formulas);
  }
  function handleRedo() {
    const snap = undoRedo.redo();
    if (!snap) return;
    setSheetCells(snap.cells);
    setSheetFormulas(snap.formulas);
  }

  function clearSelection() {
    if (!sheetSelection) return;
    const r1 = Math.min(sheetSelection.r1, sheetSelection.r2), r2 = Math.max(sheetSelection.r1, sheetSelection.r2);
    const c1 = Math.min(sheetSelection.c1, sheetSelection.c2), c2 = Math.max(sheetSelection.c1, sheetSelection.c2);
    const nextCells = { ...sheetCells };
    const nextFormulas = { ...sheetFormulas };
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      delete nextCells[`R${r}C${c}`];
      delete nextFormulas[`R${r}C${c}`];
    }
    applyGridChange(nextCells, nextFormulas);
  }

  function moveSelection(dr: number, dc: number, extend: boolean) {
    setSheetSelection(prev => {
      const baseR = prev ? prev.r2 : 0;
      const baseC = prev ? prev.c2 : 0;
      const newR = Math.max(0, Math.min(numRows - 1, baseR + dr));
      const newC = Math.max(0, Math.min(numCols - 1, baseC + dc));
      if (extend && prev) return { ...prev, r2: newR, c2: newC };
      return { r1: newR, c1: newC, r2: newR, c2: newC };
    });
  }

  function moveTab(reverse: boolean) {
    setSheetSelection(prev => {
      const r = prev ? prev.r2 : 0;
      const c = prev ? prev.c2 : 0;
      let nr = r, nc = c + (reverse ? -1 : 1);
      if (nc < 0) { nc = numCols - 1; nr = Math.max(0, nr - 1); }
      if (nc >= numCols) { nc = 0; nr = Math.min(numRows - 1, nr + 1); }
      return { r1: nr, c1: nc, r2: nr, c2: nc };
    });
  }

  function handleCopy(cut: boolean) {
    if (!sheetSelection) return;
    const r1 = Math.min(sheetSelection.r1, sheetSelection.r2), r2 = Math.max(sheetSelection.r1, sheetSelection.r2);
    const c1 = Math.min(sheetSelection.c1, sheetSelection.c2), c2 = Math.max(sheetSelection.c1, sheetSelection.c2);
    const values: Record<string, string> = {};
    for (let r = r1; r <= r2; r++) for (let c = c1; c <= c2; c++) {
      values[`${r - r1},${c - c1}`] = displayGrid[`R${r}C${c}`] ?? "";
    }
    clipboardRef.current = { values, r1, c1, r2, c2, cut };
  }

  function handlePaste() {
    if (!clipboardRef.current || !sheetSelection) return;
    const clip = clipboardRef.current;
    const anchorR = Math.min(sheetSelection.r1, sheetSelection.r2);
    const anchorC = Math.min(sheetSelection.c1, sheetSelection.c2);
    const nextCells = { ...sheetCells };
    const nextFormulas = { ...sheetFormulas };
    Object.entries(clip.values).forEach(([rel, val]) => {
      const [dr, dc] = rel.split(",").map(Number);
      const r = anchorR + dr, c = anchorC + dc;
      if (r < 0 || r >= numRows || c < 0 || c >= numCols) return;
      const key = `R${r}C${c}`;
      nextCells[key] = val;
      delete nextFormulas[key];
    });
    if (clip.cut) {
      for (let r = clip.r1; r <= clip.r2; r++) for (let c = clip.c1; c <= clip.c2; c++) {
        delete nextCells[`R${r}C${c}`];
        delete nextFormulas[`R${r}C${c}`];
      }
      clipboardRef.current = null;
    }
    applyGridChange(nextCells, nextFormulas);
  }

  useKeyboardShortcuts([
    { key: "Escape", allowInInputs: true, handler: () => { if (activeFunction) cancelWizard(); } },
    { key: "Enter", handler: () => {
        if (activeFunction || editingCell || !sheetSelection) return;
        const r = sheetSelection.r1, c = sheetSelection.c1;
        setEditingValue(sheetCells[`R${r}C${c}`] ?? "");
        setEditingCell({ r, c });
      } },
    { key: "F2", handler: () => {
        if (activeFunction || editingCell || !sheetSelection) return;
        const r = sheetSelection.r1, c = sheetSelection.c1;
        setEditingValue(sheetCells[`R${r}C${c}`] ?? "");
        setEditingCell({ r, c });
      } },
    { key: "Backspace", handler: () => { if (!activeFunction && !editingCell) clearSelection(); } },
    { key: "Delete", handler: () => { if (!activeFunction && !editingCell) clearSelection(); } },
    { key: "ArrowUp", handler: () => { if (!activeFunction && !editingCell) moveSelection(-1, 0, false); } },
    { key: "ArrowDown", handler: () => { if (!activeFunction && !editingCell) moveSelection(1, 0, false); } },
    { key: "ArrowLeft", handler: () => { if (!activeFunction && !editingCell) moveSelection(0, -1, false); } },
    { key: "ArrowRight", handler: () => { if (!activeFunction && !editingCell) moveSelection(0, 1, false); } },
    { key: "ArrowUp", shift: true, handler: () => { if (!activeFunction && !editingCell) moveSelection(-1, 0, true); } },
    { key: "ArrowDown", shift: true, handler: () => { if (!activeFunction && !editingCell) moveSelection(1, 0, true); } },
    { key: "ArrowLeft", shift: true, handler: () => { if (!activeFunction && !editingCell) moveSelection(0, -1, true); } },
    { key: "ArrowRight", shift: true, handler: () => { if (!activeFunction && !editingCell) moveSelection(0, 1, true); } },
    { key: "Tab", handler: () => { if (!activeFunction && !editingCell) moveTab(false); } },
    { key: "Tab", shift: true, handler: () => { if (!activeFunction && !editingCell) moveTab(true); } },
    { key: "c", ctrl: true, handler: () => { if (!activeFunction && !editingCell) handleCopy(false); } },
    { key: "x", ctrl: true, handler: () => { if (!activeFunction && !editingCell) handleCopy(true); } },
    { key: "v", ctrl: true, handler: () => { if (!activeFunction && !editingCell) handlePaste(); } },
    { key: "z", ctrl: true, handler: () => { if (!activeFunction && !editingCell) handleUndo(); } },
    { key: "y", ctrl: true, handler: () => { if (!activeFunction && !editingCell) handleRedo(); } },
    { key: "s", ctrl: true, handler: () => {
        if (activeFunction || showSheetSaveMapper || sheetSaving) return;
        if (editingCell) commitEdit(editingCell.r, editingCell.c, editingValue);
        handleOpenSheetSave();
      } },
  ]);

  useEffect(() => {
    function onKeyDownType(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      if (activeFunction || editingCell || !sheetSelection) return;
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const r = sheetSelection.r1, c = sheetSelection.c1;
        if (r !== sheetSelection.r2 || c !== sheetSelection.c2) return;
        setEditingValue(e.key);
        setEditingCell({ r, c });
      }
    }
    window.addEventListener("keydown", onKeyDownType);
    return () => window.removeEventListener("keydown", onKeyDownType);
  }, [activeFunction, editingCell, sheetSelection]);

  function buildRangeArgSpec(sel: { r1: number; c1: number; r2: number; c2: number }): FormulaArgSpec {
    return { kind: "range", r1: sel.r1, c1: sel.c1, r2: sel.r2, c2: sel.c2 };
  }
  function buildCellArgSpec(sel: { r1: number; c1: number; r2: number; c2: number }): FormulaArgSpec | null {
    if (sel.r1 !== sel.r2 || sel.c1 !== sel.c2) return null;
    return { kind: "cell", r: sel.r1, c: sel.c1 };
  }
  function isCellCollected(r: number, c: number): boolean {
    return collectedArgs.some(spec => {
      if (spec.kind === "cell") return spec.r === r && spec.c === c;
      if (spec.kind === "range") {
        const r1 = Math.min(spec.r1, spec.r2), r2 = Math.max(spec.r1, spec.r2);
        const c1 = Math.min(spec.c1, spec.c2), c2 = Math.max(spec.c1, spec.c2);
        return r >= r1 && r <= r2 && c >= c1 && c <= c2;
      }
      return false;
    });
  }

  function startFunction(fn: SheetFunctionDef) {
    setActiveFunction(fn);
    setWizardStepIndex(0);
    setCollectedArgs([]);
    setWizardTextValue("");
    setSheetSelection(null);
    setEditingCell(null);
  }
  function cancelWizard() {
    setActiveFunction(null);
    setWizardStepIndex(0);
    setCollectedArgs([]);
    setWizardTextValue("");
  }
  function confirmWizardStep() {
    if (!activeFunction) return;
    const spec = activeFunction.args[wizardStepIndex];
    if (spec.kind === "text") {
      setCollectedArgs(prev => [...prev, { kind: "text", value: wizardTextValue }]);
      setWizardTextValue("");
      setWizardStepIndex(i => i + 1);
      return;
    }
    if (!sheetSelection) { alert("Select a range or cell on the sheet first."); return; }
    if (spec.kind === "cell") {
      const arg = buildCellArgSpec(sheetSelection);
      if (!arg) { alert("Select a single cell for this step."); return; }
      setCollectedArgs(prev => [...prev, arg]);
    } else {
      setCollectedArgs(prev => [...prev, buildRangeArgSpec(sheetSelection)]);
    }
    setSheetSelection(null);
    setWizardStepIndex(i => i + 1);
  }
  function finalizeWizard(r: number, c: number) {
    if (!activeFunction) return;
    const key = `R${r}C${c}`;
    const nextFormulas = { ...sheetFormulas, [key]: { fnName: activeFunction.name, args: collectedArgs } };
    const nextCells = { ...sheetCells };
    delete nextCells[key];
    applyGridChange(nextCells, nextFormulas);
    cancelWizard();
    setSheetSelection(null);
  }
  function handleCellClick(r: number, c: number) {
    if (activeFunction && wizardStepIndex === activeFunction.args.length) {
      finalizeWizard(r, c);
    }
  }
  function handleCellMouseDown(r: number, c: number, shiftKey: boolean, e: React.MouseEvent) {
    if (activeFunction && wizardStepIndex === activeFunction.args.length) return;
    if (editingCell) {
      if (editingCell.r === r && editingCell.c === c) return;
      commitEdit(editingCell.r, editingCell.c, editingValue);
    }
    e.preventDefault();
    if (shiftKey && sheetSelection) {
      setSheetSelection({ ...sheetSelection, r2: r, c2: c });
    } else {
      setSheetSelection({ r1: r, c1: c, r2: r, c2: c });
    }
    setDragMode("cell");
    setIsDragging(true);
  }
  function handleCellMouseEnter(r: number, c: number) {
    if (!isDragging || dragMode !== "cell") return;
    setSheetSelection(prev => prev ? { ...prev, r2: r, c2: c } : { r1: r, c1: c, r2: r, c2: c });
  }
  function handleColumnHeaderMouseDown(c: number, shiftKey: boolean, e: React.MouseEvent) {
    if (activeFunction && wizardStepIndex === activeFunction.args.length) return;
    if (editingCell) commitEdit(editingCell.r, editingCell.c, editingValue);
    e.preventDefault();
    if (shiftKey && sheetSelection) {
      setSheetSelection({ ...sheetSelection, r1: 0, r2: numRows - 1, c2: c });
    } else {
      setSheetSelection({ r1: 0, c1: c, r2: numRows - 1, c2: c });
    }
    setDragMode("column");
    setIsDragging(true);
  }
  function handleColumnHeaderMouseEnter(c: number) {
    if (!isDragging || dragMode !== "column") return;
    setSheetSelection(prev => prev ? { ...prev, c2: c } : { r1: 0, c1: c, r2: numRows - 1, c2: c });
  }
  function handleRowHeaderMouseDown(r: number, shiftKey: boolean, e: React.MouseEvent) {
    if (activeFunction && wizardStepIndex === activeFunction.args.length) return;
    if (editingCell) commitEdit(editingCell.r, editingCell.c, editingValue);
    e.preventDefault();
    if (shiftKey && sheetSelection) {
      setSheetSelection({ ...sheetSelection, c1: 0, c2: numCols - 1, r2: r });
    } else {
      setSheetSelection({ r1: r, c1: 0, r2: r, c2: numCols - 1 });
    }
    setDragMode("row");
    setIsDragging(true);
  }
  function handleRowHeaderMouseEnter(r: number) {
    if (!isDragging || dragMode !== "row") return;
    setSheetSelection(prev => prev ? { ...prev, r2: r } : { r1: r, c1: 0, r2: r, c2: numCols - 1 });
  }
  function handleSelectAll() {
    if (editingCell) commitEdit(editingCell.r, editingCell.c, editingValue);
    setSheetSelection({ r1: 0, c1: 0, r2: numRows - 1, c2: numCols - 1 });
  }
  function insertRow(at: number) {
    if (editingCell) commitEdit(editingCell.r, editingCell.c, editingValue);
    setSheetCells(prev => {
      const next: Record<string, string> = {};
      Object.entries(prev).forEach(([key, val]) => {
        const m = key.match(/^R(\d+)C(\d+)$/);
        if (!m) return;
        const r = parseInt(m[1], 10), c = parseInt(m[2], 10);
        next[`R${r >= at ? r + 1 : r}C${c}`] = val;
      });
      return next;
    });
    setSheetFormulas(prev => {
      const next: Record<string, SheetFormula> = {};
      Object.entries(prev).forEach(([key, formula]) => {
        const m = key.match(/^R(\d+)C(\d+)$/);
        if (!m) return;
        const r = parseInt(m[1], 10), c = parseInt(m[2], 10);
        const newKey = `R${r >= at ? r + 1 : r}C${c}`;
        const shiftedArgs = formula.args.map((spec): FormulaArgSpec => {
          if (spec.kind === "range") return { ...spec, r1: spec.r1 >= at ? spec.r1 + 1 : spec.r1, r2: spec.r2 >= at ? spec.r2 + 1 : spec.r2 };
          if (spec.kind === "cell") return { ...spec, r: spec.r >= at ? spec.r + 1 : spec.r };
          return spec;
        });
        next[newKey] = { ...formula, args: shiftedArgs };
      });
      return next;
    });
    setSheetRowIds(prev => {
      const next: Record<number, number> = {};
      Object.entries(prev).forEach(([rStr, id]) => {
        const r = Number(rStr);
        next[r >= at ? r + 1 : r] = id;
      });
      return next;
    });
    setNumRows(n => n + 1);
    setSheetSelection(null);
  }
  function insertColumn(at: number) {
    if (editingCell) commitEdit(editingCell.r, editingCell.c, editingValue);
    setSheetCells(prev => {
      const next: Record<string, string> = {};
      Object.entries(prev).forEach(([key, val]) => {
        const m = key.match(/^R(\d+)C(\d+)$/);
        if (!m) return;
        const r = parseInt(m[1], 10), c = parseInt(m[2], 10);
        next[`R${r}C${c >= at ? c + 1 : c}`] = val;
      });
      return next;
    });
    setSheetFormulas(prev => {
      const next: Record<string, SheetFormula> = {};
      Object.entries(prev).forEach(([key, formula]) => {
        const m = key.match(/^R(\d+)C(\d+)$/);
        if (!m) return;
        const r = parseInt(m[1], 10), c = parseInt(m[2], 10);
        const newKey = `R${r}C${c >= at ? c + 1 : c}`;
        const shiftedArgs = formula.args.map((spec): FormulaArgSpec => {
          if (spec.kind === "range") return { ...spec, c1: spec.c1 >= at ? spec.c1 + 1 : spec.c1, c2: spec.c2 >= at ? spec.c2 + 1 : spec.c2 };
          if (spec.kind === "cell") return { ...spec, c: spec.c >= at ? spec.c + 1 : spec.c };
          return spec;
        });
        next[newKey] = { ...formula, args: shiftedArgs };
      });
      return next;
    });
    setNumCols(n => n + 1);
    setSheetSelection(null);
  }
  function selectionLabel(): string {
    if (!sheetSelection) return "No selection";
    const r1 = Math.min(sheetSelection.r1, sheetSelection.r2), r2 = Math.max(sheetSelection.r1, sheetSelection.r2);
    const c1 = Math.min(sheetSelection.c1, sheetSelection.c2), c2 = Math.max(sheetSelection.c1, sheetSelection.c2);
    if (r1 === r2 && c1 === c2) return cellLabel(r1, c1);
    return `${cellLabel(r1, c1)}:${cellLabel(r2, c2)}`;
  }
  function formulaBarValue(): string {
    if (!sheetSelection) return "";
    if (sheetSelection.r1 !== sheetSelection.r2 || sheetSelection.c1 !== sheetSelection.c2) return "";
    const key = `R${sheetSelection.r1}C${sheetSelection.c1}`;
    if (editingCell && editingCell.r === sheetSelection.r1 && editingCell.c === sheetSelection.c1) return editingValue;
    const formula = sheetFormulas[key];
    if (formula) return formulaText(formula);
    return sheetCells[key] ?? "";
  }
  function parseCellRef(ref: string): { r: number; c: number } | null {
    const m = ref.trim().toUpperCase().match(/^([A-Z]+)(\d+)$/);
    if (!m) return null;
    const c = parseColLetter(m[1]);
    const r = parseInt(m[2], 10) - 1;
    if (c === null || c < 0 || c >= numCols || r < 0 || r >= numRows) return null;
    return { r, c };
  }
  function parseRangeRef(input: string): { r1: number; c1: number; r2: number; c2: number } | null {
    const parts = input.trim().split(":");
    if (parts.length === 1) {
      const cell = parseCellRef(parts[0]);
      return cell ? { r1: cell.r, c1: cell.c, r2: cell.r, c2: cell.c } : null;
    }
    if (parts.length === 2) {
      const a = parseCellRef(parts[0]);
      const b = parseCellRef(parts[1]);
      return a && b ? { r1: a.r, c1: a.c, r2: b.r, c2: b.c } : null;
    }
    return null;
  }
  function handleNameBoxKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      const parsed = parseRangeRef(nameBoxInput);
      if (!parsed) {
        alert(`"${nameBoxInput}" isn't a valid cell or range (try something like G10 or G1:H1).`);
        return;
      }
      if (editingCell) commitEdit(editingCell.r, editingCell.c, editingValue);
      setSheetSelection(parsed);
      (e.target as HTMLInputElement).blur();
    } else if (e.key === "Escape") {
      setNameBoxInput(selectionLabel());
      (e.target as HTMLInputElement).blur();
    }
  }
  function handleNameBoxBlur() {
    setNameBoxEditing(false);
    setNameBoxInput(selectionLabel());
  }
  function handleCellDoubleClick(r: number, c: number) {
    if (activeFunction) return;
    setEditingValue(sheetCells[`R${r}C${c}`] ?? "");
    setEditingCell({ r, c });
  }
  function commitEdit(r: number, c: number, value: string) {
    const key = `R${r}C${c}`;
    const nextCells = { ...sheetCells, [key]: value };
    const nextFormulas = { ...sheetFormulas };
    delete nextFormulas[key];
    applyGridChange(nextCells, nextFormulas);
    setEditingCell(null);
  }
  function handleLoadTransactionData() {
    const headers = ["Product", "Customer", "Year", "Month", "Quantity", "Total Value"];
    const next: Record<string, string> = {};
    const nextRowIds: Record<number, number> = {};
    headers.forEach((h, c) => { next[`R0C${c}`] = h; });
    rows.forEach((tx, i) => {
      const r = i + 1;
      next[`R${r}C0`] = tx.product;
      next[`R${r}C1`] = tx.customer;
      next[`R${r}C2`] = String(tx.year);
      next[`R${r}C3`] = tx.month;
      next[`R${r}C4`] = String(tx.quantity);
      next[`R${r}C5`] = String(tx.total_value);
      nextRowIds[r] = tx.id;
    });
    setNumRows(n => Math.max(n, rows.length + 1));
    setNumCols(n => Math.max(n, headers.length));
    setSheetFormulas({});
    setSheetCells(next);
    setSheetRowIds(nextRowIds);
    setSheetSelection(null);
  }
  function handleClearSheet() {
    if (Object.keys(sheetCells).length === 0 && Object.keys(sheetFormulas).length === 0) return;
    const confirmed = window.confirm("Clear everything on this sheet? Unsaved data and formulas will be lost.");
    if (!confirmed) return;
    setSheetCells({});
    setSheetFormulas({});
    setSheetRowIds({});
    setSheetSelection(null);
    cancelWizard();
  }

  function getUsedRange(): { maxRow: number; maxCol: number } | null {
    let maxRow = -1, maxCol = -1;
    Object.entries(displayGrid).forEach(([key, val]) => {
      if (val.trim() === "") return;
      const m = key.match(/^R(\d+)C(\d+)$/);
      if (!m) return;
      const r = parseInt(m[1], 10), c = parseInt(m[2], 10);
      if (r > maxRow) maxRow = r;
      if (c > maxCol) maxCol = c;
    });
    return maxRow === -1 ? null : { maxRow, maxCol };
  }

  const [showSheetSaveMapper, setShowSheetSaveMapper] = useState(false);
  const [sheetSaveHeaders, setSheetSaveHeaders] = useState<string[]>([]);
  const [sheetSaveMappings, setSheetSaveMappings] = useState<Record<string, ImportMapping>>({});
  const [sheetSaving, setSheetSaving] = useState(false);

  function handleOpenSheetSave() {
    const used = getUsedRange();
    if (!used) { alert("The sheet is empty."); return; }
    const headers: string[] = [];
    for (let c = 0; c <= used.maxCol; c++) {
      headers.push((displayGrid[`R0C${c}`] ?? "").trim() || colLetter(c));
    }
    const initialMappings: Record<string, ImportMapping> = {};
    const usedRoles = new Set<string>();
    headers.forEach((h, index) => {
      const guessed = guessRole(h);
      if (guessed && !usedRoles.has(guessed)) {
        usedRoles.add(guessed);
        initialMappings[String(index)] = { role: guessed, fieldName: h, fieldType: "text" };
      } else {
        const existing = customFields.find(cf => cf.name.toLowerCase() === h.toLowerCase());
        initialMappings[String(index)] = existing
          ? { role: "custom", fieldName: existing.name, fieldType: existing.field_type === "number" ? "number" : "text" }
          : { role: "custom", fieldName: h, fieldType: "text" };
      }
    });
    setSheetSaveHeaders(headers);
    setSheetSaveMappings(initialMappings);
    setShowSheetSaveMapper(true);
  }

  function updateSheetSaveMapping(index: number, patch: Partial<ImportMapping>) {
    const key = String(index);
    setSheetSaveMappings(prev => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  }

  function handleCancelSheetSave() {
    setShowSheetSaveMapper(false);
    setSheetSaveHeaders([]);
    setSheetSaveMappings({});
  }

  async function handleConfirmSheetSave() {
    const used = getUsedRange();
    if (!used) { setShowSheetSaveMapper(false); return; }

    const requiredRoles = ["product", "customer", "year", "month", "quantity", "total_value"];
    const roleCounts = requiredRoles.map(role => ({
      role,
      count: sheetSaveHeaders.filter((_, index) => sheetSaveMappings[String(index)]?.role === role).length,
    }));
    const invalidRole = roleCounts.find(({ count }) => count !== 1);
    if (invalidRole) {
      alert(`Map exactly one column to ${STANDARD_ROLE_OPTIONS.find(o => o.value === invalidRole.role)?.label ?? invalidRole.role} before saving.`);
      return;
    }
    const customEntries = sheetSaveHeaders
      .map((_, index) => sheetSaveMappings[String(index)])
      .filter(m => m?.role === "custom");
    const customNamesLower = customEntries.map(m => m.fieldName.trim().toLowerCase());
    if (customNamesLower.some(n => !n) || new Set(customNamesLower).size !== customNamesLower.length) {
      alert("Each custom column needs a unique field name before saving.");
      return;
    }

    setSheetSaving(true);
    try {
      for (const m of customEntries) {
        await invoke("add_custom_field", { name: m.fieldName.trim(), fieldType: m.fieldType });
      }

      const colToRole: Record<number, ImportMapping> = {};
      sheetSaveHeaders.forEach((_, index) => {
        const m = sheetSaveMappings[String(index)];
        if (m.role !== "skip") colToRole[index] = m;
      });

      const updateRows: { id: number; product: string; customer: string; year: number; month: string; quantity: number; total_value: number; extra: string }[] = [];
      const insertRows: { product: string; customer: string; year: number; month: string; quantity: number; total_value: number; extra: string }[] = [];
      for (let r = 1; r <= used.maxRow; r++) {
        let product = "", customer = "", month = "";
        let year = 0, quantity = 0, total_value = 0;
        const extra: Record<string, string> = {};
        let hasAny = false;

        Object.entries(colToRole).forEach(([idxStr, m]) => {
          const idx = Number(idxStr);
          const val = displayGrid[`R${r}C${idx}`] ?? "";
          if (val.trim() !== "") hasAny = true;
          if (m.role === "product") product = val;
          else if (m.role === "customer") customer = val;
          else if (m.role === "year") year = Math.round(numOf(val)) || 0;
          else if (m.role === "month") month = val;
          else if (m.role === "quantity") quantity = Math.round(numOf(val)) || 0;
          else if (m.role === "total_value") total_value = numOf(val) || 0;
          else if (m.role === "custom") extra[m.fieldName.trim()] = val;
        });

        if (!hasAny || product.trim() === "") continue;

        const originalId = sheetRowIds[r];
        const original = originalId != null ? rows.find(tx => tx.id === originalId) : undefined;
        if (original) {
          let parsedOriginalExtra: Record<string, string> = {};
          try { parsedOriginalExtra = JSON.parse(original.extra || "{}"); } catch { parsedOriginalExtra = {}; }
          const mergedExtra = { ...parsedOriginalExtra, ...extra };
          updateRows.push({ id: original.id, product, customer, year, month, quantity, total_value, extra: JSON.stringify(mergedExtra) });
        } else {
          insertRows.push({ product, customer, year, month, quantity, total_value, extra: JSON.stringify(extra) });
        }
      }

      if (updateRows.length === 0 && insertRows.length === 0) {
        alert("No rows with a Product value were found below the header row.");
        return;
      }

      let updatedCount = 0;
      let insertedCount = 0;
      if (updateRows.length > 0) {
        await invoke("update_transactions", { rows: updateRows });
        updatedCount = updateRows.length;
      }
      if (insertRows.length > 0) {
        insertedCount = await invoke<number>("add_transactions", { rows: insertRows });
      }
      alert(`Saved: ${updatedCount} updated, ${insertedCount} added.`);
      await refreshTransactions();
      await refreshCustomFields();
      setShowSheetSaveMapper(false);
    } catch (err) {
      alert(`Failed to save: ${err}`);
    } finally {
      setSheetSaving(false);
    }
  }

  async function handleExportSheet() {
    const used = getUsedRange();
    if (!used) { alert("The sheet is empty."); return; }

    const columns: string[] = [];
    for (let c = 0; c <= used.maxCol; c++) {
      columns.push((displayGrid[`R0C${c}`] ?? "").trim() || colLetter(c));
    }
    const rowsOut: string[][] = [];
    for (let r = 1; r <= used.maxRow; r++) {
      const rowVals: string[] = [];
      let hasAny = false;
      for (let c = 0; c <= used.maxCol; c++) {
        const v = displayGrid[`R${r}C${c}`] ?? "";
        if (v.trim() !== "") hasAny = true;
        rowVals.push(v);
      }
      if (hasAny) rowsOut.push(rowVals);
    }
    if (rowsOut.length === 0) { alert("No data rows to export below the header row."); return; }

    const numericCols: number[] = [];
    for (let c = 0; c <= used.maxCol; c++) {
      const colVals = rowsOut.map(row => row[c]).filter(v => v.trim() !== "");
      if (colVals.length > 0 && colVals.every(v => Number.isFinite(numOf(v)))) numericCols.push(c);
    }

    try {
      const path = await save({ defaultPath: "sheet_export.xlsx", filters: [{ name: "Excel", extensions: ["xlsx"] }] });
      if (!path) return;
      await invoke("export_report", { savePath: path, columns, rows: rowsOut, numericCols });
      alert("Exported successfully.");
    } catch (err) {
      alert(`Export failed: ${err}`);
    }
  }

  return (
    <>
      <style>{`
        .sheet-layout{display:flex; gap:16px; align-items:flex-start;}
        .sheet-functions{width:190px; flex-shrink:0;}
        .sheet-functions .btn{margin-left:0; margin-bottom:6px; width:100%; text-align:left;}
        .sheet-scroll{flex:1; overflow:auto; border:1px solid #1A2540; border-radius:8px;}
        .sheet-table{border-collapse:collapse;}
        .sheet-table th{background:#0E1728; color:#8B98B4; font-size:11px; font-weight:600; padding:6px; border:1px solid #1A2540; min-width:90px; user-select:none;}
        .sheet-rownum{background:#0E1728; color:#8B98B4; font-size:11px; text-align:center; padding:6px; border:1px solid #1A2540; cursor:e-resize; user-select:none; position:relative;}
        .sheet-corner{cursor:pointer;}
        .sheet-col-header{cursor:s-resize; position:relative;}
        .sheet-header-selected{background:#123049 !important; color:#38BDF8 !important;}
        .sheet-add-col-btn{position:absolute; top:0; right:-9px; width:16px; height:100%; background:transparent; border:none; color:#38BDF8; font-size:14px; font-weight:700; cursor:pointer; opacity:0; transition:opacity .1s; z-index:5; display:flex; align-items:center; justify-content:center; padding:0;}
        .sheet-col-header:hover .sheet-add-col-btn{opacity:1; background:#0E1728; border-left:1px solid #38BDF8;}
        .sheet-add-row-btn{position:absolute; left:0; bottom:-9px; width:100%; height:14px; background:transparent; border:none; color:#38BDF8; font-size:12px; font-weight:700; cursor:pointer; opacity:0; transition:opacity .1s; z-index:5; display:flex; align-items:center; justify-content:center; padding:0;}
        .sheet-rownum:hover .sheet-add-row-btn{opacity:1; background:#0E1728; border-top:1px solid #38BDF8;}
        .sheet-left-col{display:flex; flex-direction:column; gap:8px; width:190px; flex-shrink:0;}
        .sheet-right-col{display:flex; flex-direction:column; gap:8px; flex:1; min-width:0;}
        .sheet-selection-bar{background:#111A2E; border:1px solid #1A2540; border-radius:8px; padding:8px 12px; font-size:12.5px; color:#E7ECF6; font-family:'JetBrains Mono', monospace; width:100%; outline:none;}
        .sheet-selection-bar:focus{border-color:#38BDF8;}
        .sheet-formula-bar{display:flex; align-items:center; gap:8px; background:#111A2E; border:1px solid #1A2540; border-radius:8px; padding:6px 10px;}
        .fx-label{background:#0E1728; border:1px solid #22304A; border-radius:5px; padding:3px 8px; font-size:11px; font-style:italic; color:#8B98B4; flex-shrink:0;}
        .fx-value{font-size:13px; color:#E7ECF6; font-family:'JetBrains Mono', monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
        .sheet-cell{border:1px solid #1A2540; padding:0; height:28px; width:90px; font-size:12.5px; color:#E7ECF6; cursor:cell; text-align:left; padding-left:6px; white-space:nowrap; overflow:hidden; user-select:none;}
        .sheet-cell-selected{background:rgba(56,189,248,0.15); outline:1px solid #38BDF8;}
        .sheet-cell-collected{background:rgba(52,211,153,0.15); outline:1px solid #34D399;}
        .sheet-cell-formula{color:#34D399;}
        .sheet-cell-input{width:100%; height:100%; background:#111A2E; border:none; color:#E7ECF6; font-size:12.5px; padding-left:6px;}
      `}</style>

      <div className="topbar">
        <div>
          <h1>Sheet</h1>
        </div>
        <div>
          <button className="btn" onClick={handleLoadTransactionData}>Load Transaction Data</button>
          <button className="btn" onClick={handleClearSheet}>Clear Sheet</button>
          <button className="btn" onClick={handleOpenSheetSave}>Save to Database</button>
          <button className="btn" onClick={handleExportSheet}>Export .xlsx</button>
        </div>
      </div>

      {showSheetSaveMapper && (
        <div className="modal-overlay">
          <div className="modal-panel">
            <div className="panel-title">Match your sheet's columns</div>
            <div className="sub" style={{ marginBottom: "14px" }}>
              Row 1 is treated as headers. Map each column — Product, Customer, Year, Month, Quantity, and Total Value are required.
            </div>
            {sheetSaveHeaders.map((header, index) => {
              const mapping = sheetSaveMappings[String(index)];
              if (!mapping) return null;
              return (
                <div key={index} className="filter-grid" style={{ marginBottom: "10px" }}>
                  <div className="field" style={{ flex: "0 0 150px" }}>
                    <label>Sheet column</label>
                    <div style={{ height: "38px", display: "flex", alignItems: "center", color: "#E7ECF6", fontSize: "13px" }}>{header}</div>
                  </div>
                  <div className="field">
                    <label>Maps to</label>
                    <select value={mapping.role} onChange={e => updateSheetSaveMapping(index, { role: e.target.value })}>
                      {STANDARD_ROLE_OPTIONS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </select>
                  </div>
                  {mapping.role === "custom" && (
                    <>
                      <div className="field">
                        <label>Field name</label>
                        <input value={mapping.fieldName} onChange={e => updateSheetSaveMapping(index, { fieldName: e.target.value })} />
                      </div>
                      <div className="field">
                        <label>Type</label>
                        <select value={mapping.fieldType} onChange={e => updateSheetSaveMapping(index, { fieldType: e.target.value as "text" | "number" })}>
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
              <button className="apply-btn" onClick={handleConfirmSheetSave} disabled={sheetSaving}>{sheetSaving ? "Saving..." : "Save"}</button>
              <button className="btn" onClick={handleCancelSheetSave} disabled={sheetSaving}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {activeFunction && (
        <div className="panel">
          <div className="panel-title">
            {activeFunction.name} — step {Math.min(wizardStepIndex + 1, activeFunction.args.length + 1)} of {activeFunction.args.length + 1}
          </div>
          {wizardStepIndex < activeFunction.args.length ? (
            <>
              <div className="sub" style={{ marginBottom: "10px" }}>{activeFunction.args[wizardStepIndex].label}</div>
              {activeFunction.args[wizardStepIndex].kind === "text" ? (
                <div style={{ display: "flex", gap: "8px" }}>
                  <input className="edit-input" style={{ maxWidth: "240px" }} value={wizardTextValue} onChange={e => setWizardTextValue(e.target.value)} placeholder="Type a value" />
                  <button className="apply-btn" onClick={confirmWizardStep}>Confirm</button>
                  <button className="btn" onClick={cancelWizard}>Cancel</button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
                  <span className="sub">
                    {sheetSelection
                      ? `Selected: ${cellLabel(Math.min(sheetSelection.r1, sheetSelection.r2), Math.min(sheetSelection.c1, sheetSelection.c2))}:${cellLabel(Math.max(sheetSelection.r1, sheetSelection.r2), Math.max(sheetSelection.c1, sheetSelection.c2))}`
                      : "Click a cell (or shift-click to extend a range) on the sheet"}
                  </span>
                  <button className="btn" onClick={cancelWizard}>Cancel</button>
                </div>
              )}
            </>
          ) : (
            <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
              <span className="sub">Click the cell on the sheet where the result should go</span>
              <button className="btn" onClick={cancelWizard}>Cancel</button>
            </div>
          )}
        </div>
      )}

      <div className="sheet-layout">
        <div className="sheet-left-col">
          <input
            className="sheet-selection-bar"
            value={nameBoxInput}
            onFocus={() => setNameBoxEditing(true)}
            onChange={e => setNameBoxInput(e.target.value)}
            onKeyDown={handleNameBoxKeyDown}
            onBlur={handleNameBoxBlur}
            placeholder="e.g. G10 or G1:H1"
          />
          <div className="sheet-functions panel">
            <div className="panel-title">Functions</div>
            {["Basic", "Logic", "Conditional", "Lookup"].map(cat => (
              <div key={cat} style={{ marginBottom: "12px" }}>
                <div className="sub" style={{ marginBottom: "6px" }}>{cat}</div>
                {FUNCTION_DEFS.filter(f => f.category === cat).map(f => (
                  <button key={f.name} className="btn" onClick={() => startFunction(f)}>{f.name}</button>
                ))}
              </div>
            ))}
          </div>
        </div>

        <div className="sheet-right-col">
          <div className="sheet-formula-bar">
            <span className="fx-label">fx</span>
            <span className="fx-value">{formulaBarValue()}</span>
          </div>
          <div className="sheet-scroll">
            <table className="sheet-table">
              <thead>
                <tr>
                  <th className="sheet-corner" onClick={handleSelectAll} title="Select all"></th>
                  {Array.from({ length: numCols }).map((_, c) => {
                    const colSelected = !!sheetSelection && sheetSelection.r1 === 0 && sheetSelection.r2 === numRows - 1 &&
                      c >= Math.min(sheetSelection.c1, sheetSelection.c2) && c <= Math.max(sheetSelection.c1, sheetSelection.c2);
                    return (
                      <th
                        key={c}
                        className={`sheet-col-header ${colSelected ? "sheet-header-selected" : ""}`}
                        onMouseDown={e => handleColumnHeaderMouseDown(c, e.shiftKey, e)}
                        onMouseEnter={() => handleColumnHeaderMouseEnter(c)}
                      >
                        {colLetter(c)}
                        <button
                          className="sheet-add-col-btn"
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); insertColumn(c + 1); }}
                          title="Insert column"
                        >+</button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: numRows }).map((_, r) => {
                  const rowSelected = !!sheetSelection && sheetSelection.c1 === 0 && sheetSelection.c2 === numCols - 1 &&
                    r >= Math.min(sheetSelection.r1, sheetSelection.r2) && r <= Math.max(sheetSelection.r1, sheetSelection.r2);
                  return (
                    <tr key={r}>
                      <td
                        className={`sheet-rownum ${rowSelected ? "sheet-header-selected" : ""}`}
                        onMouseDown={e => handleRowHeaderMouseDown(r, e.shiftKey, e)}
                        onMouseEnter={() => handleRowHeaderMouseEnter(r)}
                      >
                        {r + 1}
                        <button
                          className="sheet-add-row-btn"
                          onMouseDown={e => e.stopPropagation()}
                          onClick={e => { e.stopPropagation(); insertRow(r + 1); }}
                          title="Insert row"
                        >+</button>
                      </td>
                      {Array.from({ length: numCols }).map((_, c) => {
                        const key = `R${r}C${c}`;
                        const isSelected = !!sheetSelection &&
                          r >= Math.min(sheetSelection.r1, sheetSelection.r2) && r <= Math.max(sheetSelection.r1, sheetSelection.r2) &&
                          c >= Math.min(sheetSelection.c1, sheetSelection.c2) && c <= Math.max(sheetSelection.c1, sheetSelection.c2);
                        const isEditing = editingCell && editingCell.r === r && editingCell.c === c;
                        const isFormulaCell = !!sheetFormulas[key];
                        const isCollected = !!activeFunction && isCellCollected(r, c);
                        return (
                          <td
                            key={c}
                            className={`sheet-cell ${isSelected ? "sheet-cell-selected" : ""} ${isCollected ? "sheet-cell-collected" : ""} ${isFormulaCell ? "sheet-cell-formula" : ""}`}
                            onMouseDown={e => handleCellMouseDown(r, c, e.shiftKey, e)}
                            onMouseEnter={() => handleCellMouseEnter(r, c)}
                            onClick={() => handleCellClick(r, c)}
                            onDoubleClick={() => handleCellDoubleClick(r, c)}
                          >
                            {isEditing ? (
                              <input
                                autoFocus
                                className="sheet-cell-input"
                                value={editingValue}
                                onChange={e => setEditingValue(e.target.value)}
                                onBlur={() => commitEdit(r, c, editingValue)}
                                onKeyDown={e => {
                                  if (e.key === "Enter") commitEdit(r, c, editingValue);
                                  if (e.key === "Escape") setEditingCell(null);
                                }}
                              />
                            ) : (displayGrid[key] ?? "")}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

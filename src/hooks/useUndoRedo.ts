import { useCallback, useRef, useState } from "react";

interface UndoRedoOptions {
  limit?: number; // max history entries kept (default 100)
}

/**
 * Generic undo/redo history manager for any snapshot-able piece of state.
 * Call `push(nextSnapshot)` at each committed change (not on every keystroke).
 * `undo()` / `redo()` return the snapshot to restore, or null if there's nothing to do.
 */
export function useUndoRedo<T>(initial: T, options: UndoRedoOptions = {}) {
  const limit = options.limit ?? 100;
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const current = useRef<T>(initial);
  const [, forceRender] = useState(0);

  const push = useCallback((snapshot: T) => {
    past.current.push(current.current);
    if (past.current.length > limit) past.current.shift();
    current.current = snapshot;
    future.current = [];
    forceRender(n => n + 1);
  }, [limit]);

  const undo = useCallback((): T | null => {
    if (past.current.length === 0) return null;
    const prev = past.current.pop()!;
    future.current.push(current.current);
    current.current = prev;
    forceRender(n => n + 1);
    return prev;
  }, []);

  const redo = useCallback((): T | null => {
    if (future.current.length === 0) return null;
    const next = future.current.pop()!;
    past.current.push(current.current);
    current.current = next;
    forceRender(n => n + 1);
    return next;
  }, []);

  return { push, undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0 };
}
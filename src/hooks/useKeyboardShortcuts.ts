import { useEffect } from "react";

export type ShortcutHandler = (e: KeyboardEvent) => void;

export interface ShortcutDef {
  key: string;              // e.g. "c", "ArrowUp", "F2", "Escape", "Tab"
  ctrl?: boolean;            // matches Ctrl (Win/Linux) or Cmd (Mac)
  shift?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
  allowInInputs?: boolean;   // fire even while focus is in an input/select/textarea
  preventDefault?: boolean;  // defaults to true
}

function eventMatches(e: KeyboardEvent, def: ShortcutDef): boolean {
  if (e.key.toLowerCase() !== def.key.toLowerCase()) return false;
  const ctrlPressed = e.ctrlKey || e.metaKey;
  if (!!def.ctrl !== ctrlPressed) return false;
  if (!!def.shift !== e.shiftKey) return false;
  if (!!def.alt !== e.altKey) return false;
  return true;
}

/**
 * Registers a set of keyboard shortcuts on the window while `enabled` is true.
 * Reusable across features — pass a different `defs` array per feature (Sheet, Dashboard, etc).
 */
export function useKeyboardShortcuts(defs: ShortcutDef[], enabled: boolean = true) {
  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const inInput = !!target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName);

      for (const def of defs) {
        if (inInput && !def.allowInInputs) continue;
        if (eventMatches(e, def)) {
          if (def.preventDefault !== false) e.preventDefault();
          def.handler(e);
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [defs, enabled]);
}
import { Extension } from '@tiptap/core';
/**
 * Workaround for ProseMirror/Chrome drag-selection breakage.
 *
 * Problem 1 — selectionToDOM overwrites native drag selection:
 * During a mouse drag, Chrome fires `selectionchange` events on every mouse
 * move. ProseMirror's DOMObserver picks these up, dispatches selection-only
 * transactions, and calls `selectionToDOM()` to push the ProseMirror selection
 * back to the DOM. A Chrome-specific guard in `selectionToDOM` should detect
 * the drag and bail out, but it relies on `isEquivalentPosition()` — a DOM
 * scan that stops at `contenteditable="false"` boundaries and fails when
 * ProseMirror ↔ DOM position mapping is lossy (tables, raw-HTML atom nodes).
 *
 * Problem 2 — prosemirror-tables forces selectionToDOM:
 * The prosemirror-tables plugin has its own mousedown handler that registers a
 * mousemove listener. When the user drags from one cell to another (or outside
 * the table), it dispatches `CellSelection` transactions that cause decoration
 * changes, which force `selectionToDOM(view, true)` — bypassing both guards.
 *
 * Problem 3 — post-mouseup selection round-trip loses table highlight:
 * Chrome renders drag-created selections differently from programmatically-set
 * selections. ProseMirror's `selectionToDOM` uses `collapse()`+`extend()` to
 * set the DOM selection, which causes Chrome to lose the native table-cell
 * highlighting that the drag selection had.
 *
 * Fix — three layers:
 * 1. Suppress `DOMObserver.onSelectionChange` during drag so the
 *    selectionchange → flush → dispatch → selectionToDOM path never fires.
 *    Call `setCurSelection()` to keep the stored DOM selection fresh so the
 *    `updateStateInner` guard passes for any direct dispatches.
 * 2. Block `CellSelection` transactions via `filterTransaction` during drag,
 *    preventing the prosemirror-tables decoration path.
 * 3. On mouseup, save the native selection, flush the DOMObserver to sync
 *    ProseMirror state, then restore the native selection so Chrome preserves
 *    the table highlight.
 *
 * Safe to revisit when ProseMirror's Chrome drag guard improves upstream.
 */
export declare const DragSelectionGuard: Extension<any, any>;

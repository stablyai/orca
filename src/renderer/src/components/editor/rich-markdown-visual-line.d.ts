import type { EditorView } from '@tiptap/pm/view';
/**
 * Why: a paragraph that word-wraps across multiple screen lines should be cut
 * one visual line at a time when the user presses Cmd+X with an empty selection,
 * matching the expectation of per-line editing.  Uses ProseMirror's coordinate
 * helpers to detect visual line boundaries from the browser's text layout.
 *
 * Returns the document-position range of the visual line the cursor sits on,
 * or null when the paragraph fits on a single visual line (signaling the caller
 * to fall through to block-level cut).
 */
export declare function getVisualLineRange(view: EditorView, cursorPos: number, paraStart: number, paraEnd: number): {
    from: number;
    to: number;
} | null;
/**
 * Cuts a single visual line from a word-wrapped paragraph, writing both
 * text/plain and text/html to the clipboard and deleting the range from
 * the ProseMirror document.  Returns true if the cut was handled.
 */
export declare function cutVisualLine(view: EditorView, event: Event, lineRange: {
    from: number;
    to: number;
}): boolean;

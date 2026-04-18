import type { Editor } from '@tiptap/core';
/**
 * Why: the `marked` parser (with `breaks: false`, the default) treats consecutive
 * lines without a blank separator as a single paragraph with literal `\n` characters
 * in the text content (e.g. "Line one\nLine two\nLine three").  These `\n` chars are
 * invisible in the rendered HTML (normal `white-space` collapsing), but they cause
 * the block-cut handler to remove the entire multi-line paragraph on Cmd+X instead
 * of just one logical line.
 *
 * This function normalises the ProseMirror document by splitting any paragraph whose
 * text nodes contain `\n` into separate paragraph nodes — one per line.  Inline marks
 * (bold, italic, links, etc.) are preserved on each resulting paragraph.  This is
 * structurally correct for the editing model: each visual line becomes its own block,
 * so the cut handler (and all other block-level operations) work on a per-line basis.
 */
export declare function normalizeSoftBreaks(editor: Editor): void;

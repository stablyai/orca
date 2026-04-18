import type { Editor } from '@tiptap/react';
/**
 * Auto-focuses the rich markdown editor on mount so users can start typing
 * immediately (matching MonacoEditor's behavior). Guards against focus theft
 * from modals/dialogs and skips scrollIntoView to avoid racing with
 * useEditorScrollRestore.
 */
export declare function autoFocusRichEditor(nextEditor: Editor, rootEl: HTMLElement | null): void;

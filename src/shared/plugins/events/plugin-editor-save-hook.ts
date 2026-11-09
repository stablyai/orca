/** The IPC answer to `plugins:editorSaveHook`: save `text` (null: the buffer as it was), or don't. */
export type EditorSaveHookDecision =
  | { kind: 'continue'; text: string | null }
  | { kind: 'deny'; pluginKey: string; reason: string }

import type { editor } from 'monaco-editor'
export type EditorViewTransfer = {
  text: string
  version: number
  state: editor.ICodeEditorViewState | null
  rich?: { selection: Record<string, unknown>; scrollTop: number }
}
const readers = new Map<string, () => EditorViewTransfer>()
const snapshots = new Map<string, EditorViewTransfer>()
export function captureEditorView(id: string): EditorViewTransfer | undefined {
  return readers.get(id)?.() ?? snapshots.get(id)
}
export function registerEditorView(id: string, read: () => EditorViewTransfer): () => void {
  readers.set(id, read)
  return () => {
    if (readers.get(id) === read) {
      snapshots.set(id, read())
      readers.delete(id)
    }
  }
}
export function restoreTransferredEditorView(id: string, snapshot: EditorViewTransfer): void {
  snapshots.set(id, snapshot)
}

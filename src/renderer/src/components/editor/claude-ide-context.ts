export type EditorSelection = { text: string; filePath: string }
export type EditorTab = { path: string; dirty: boolean }

export function selectionPayload(sel: EditorSelection | null): { text: string; filePath: string } | null {
  return sel ? { text: sel.text, filePath: sel.filePath } : null
}

export function openEditorsPayload(tabs: EditorTab[]): { filePath: string; isDirty: boolean }[] {
  return tabs.map((t) => ({ filePath: t.path, isDirty: t.dirty }))
}

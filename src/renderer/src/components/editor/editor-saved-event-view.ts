import type { OpenFile } from '@/store/slices/editor'

function editorSavedEventViewIds(detail: unknown): ReadonlySet<unknown> {
  if (!detail || typeof detail !== 'object' || !('fileId' in detail)) {
    return new Set()
  }
  const ids = new Set<unknown>([detail.fileId])
  if ('recordViewIds' in detail && Array.isArray(detail.recordViewIds)) {
    for (const id of detail.recordViewIds) {
      ids.add(id)
    }
  }
  return ids
}

export function isEditorSavedEventFor(detail: unknown, viewId: string): boolean {
  return editorSavedEventViewIds(detail).has(viewId)
}

/** Resolve a surviving record view when the saving view closed during the write. */
export function editorSavedEventView(
  openFiles: readonly OpenFile[],
  detail: unknown
): OpenFile | undefined {
  const ids = editorSavedEventViewIds(detail)
  const saverId = detail && typeof detail === 'object' && 'fileId' in detail ? detail.fileId : null
  return openFiles.find((file) => file.id === saverId) ?? openFiles.find((file) => ids.has(file.id))
}

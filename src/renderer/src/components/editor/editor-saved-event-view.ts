import type { OpenFile } from '@/store/slices/editor'

/** Every view a saved event's write reached: the saving view plus its record's views then. */
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

/** Whether a saved event's write reached `viewId`, even if the saving view closed mid-write. */
export function isEditorSavedEventFor(detail: unknown, viewId: string): boolean {
  return editorSavedEventViewIds(detail).has(viewId)
}

/**
 * An open view of the file a saved event reports. The saving view may have closed mid-write, so
 * the record's other views (`recordViewIds`) stand in for it.
 */
export function editorSavedEventView(
  openFiles: readonly OpenFile[],
  detail: unknown
): OpenFile | undefined {
  const ids = editorSavedEventViewIds(detail)
  const saverId = detail && typeof detail === 'object' && 'fileId' in detail ? detail.fileId : null
  return openFiles.find((file) => file.id === saverId) ?? openFiles.find((file) => ids.has(file.id))
}

import type { OpenFile } from '../types/open-file'

export function closedEditorFileSnapshot(closedFile: OpenFile) {
  const { id: _id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snap } = closedFile
  return snap
}

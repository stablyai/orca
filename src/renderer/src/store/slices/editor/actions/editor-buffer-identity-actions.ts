import type { EditorGet, EditorSet } from '../types/editor-set-get'
import type { EditorSlice } from '../types/editor-slice'
import {
  editorBufferIdentityOf,
  isEditorBufferIdentityRetired
} from '../buffers/editor-buffer-identity'
import { editorBufferIdForFile } from '../buffers/editor-buffer-identity-cache'
import {
  detachedEditorBufferId,
  editorBufferIdOfView,
  editorBufferViewIds,
  type EditorBufferDetachments
} from '../buffers/editor-buffer-views'

export function createEditorBufferIdentityActions(
  set: EditorSet,
  _get: EditorGet
): Pick<
  EditorSlice,
  | 'reconcileEditorBufferIdentities'
  | 'detachRetiredEditorBuffers'
  | 'releaseKeptEditorBuffers'
  | 'settleKeptEditorBuffers'
> {
  return {
    reconcileEditorBufferIdentities: () =>
      set((s) => ({ editorBufferIdentityRevision: s.editorBufferIdentityRevision + 1 })),

    detachRetiredEditorBuffers: (environmentIds) =>
      set((s) => {
        let detached: EditorBufferDetachments | null = null
        for (const file of s.openFiles) {
          const identity = editorBufferIdentityOf(file, s)
          if (!identity || !isEditorBufferIdentityRetired(identity, environmentIds)) {
            continue
          }
          // Why the record's first view: every view of the record moves to one kept record.
          const recordId = editorBufferIdOfView(s, file.id)
          const firstView = editorBufferViewIds(s, recordId)[0] ?? file.id
          detached ??= { ...s.editorBufferDetached }
          detached[file.id] = {
            recordId: detachedEditorBufferId(firstView),
            key: editorBufferIdForFile(file, s),
            retired: true
          }
        }
        return detached ? { editorBufferDetached: detached } : s
      }),

    releaseKeptEditorBuffers: (notice) =>
      set((s) => {
        const released = Object.entries(s.editorBufferKept).filter(
          ([, entry]) => entry.notice === notice
        )
        if (released.length === 0) {
          return s
        }
        const editorBufferKept = { ...s.editorBufferKept }
        for (const [recordId] of released) {
          delete editorBufferKept[recordId]
        }
        return { editorBufferKept }
      }),

    settleKeptEditorBuffers: (viewIds, content, signature) =>
      set((s) => {
        const settled = Object.entries(s.editorBufferKept).filter(([, entry]) =>
          entry.viewIds.some((id) => viewIds.includes(id))
        )
        if (settled.length === 0) {
          return s
        }
        const editorBufferKept = { ...s.editorBufferKept }
        for (const [recordId, entry] of settled) {
          if (entry.draft === content) {
            delete editorBufferKept[recordId]
          } else {
            editorBufferKept[recordId] = {
              ...entry,
              record: { ...entry.record, lastKnownDiskSignature: signature }
            }
          }
        }
        return { editorBufferKept }
      })
  }
}

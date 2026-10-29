import { decideEditorBufferRejoin, type EditorBufferJoinSide } from './editor-buffer-join'
import type { EditorBufferReconcileState } from './editor-buffer-reconcile-write'
import type { EditorBufferDetachments, EditorBufferViewIndex } from './editor-buffer-views'

/** `recordId`'s side as of the previous write, through its first view `isShown` accepts. */
function sideOf(
  state: EditorBufferReconcileState,
  recordId: string,
  isShown: (viewId: string) => boolean = () => true
): EditorBufferJoinSide | null {
  const record = state.editorBuffers[recordId]
  const firstView = state.editorBufferViews[recordId]?.find(isShown)
  return record && firstView !== undefined ? { record, draft: state.editorDrafts[firstView] } : null
}

/** Detached partners join only after either becomes clean; partner is current identity record or kept record from no-prompt removal. */
export function staysDetached(
  state: EditorBufferReconcileState,
  entry: EditorBufferDetachments[string],
  open: ReadonlySet<string>
): boolean {
  const own = sideOf(state, entry.recordId)
  const partner =
    sideOf(state, entry.key, (viewId) => open.has(viewId)) ??
    state.editorBufferKept[entry.key] ??
    null
  return own !== null && partner !== null && decideEditorBufferRejoin(own, partner) === null
}

/** Whether a detached view could rejoin its partner now (one side clean, or the partner closed). */
export function isEditorBufferRejoinDue(state: EditorBufferReconcileState): boolean {
  const open = new Set(state.openFiles.map((file) => file.id))
  return Object.entries(state.editorBufferDetached).some(
    ([viewId, entry]) => open.has(viewId) && !entry.retired && !staysDetached(state, entry, open)
  )
}

/** Draft-only writes can rejoin by clearing, never typing; keep this per-keystroke gate cheap. */
export function mayRejoinAfterDraftWrite(
  index: EditorBufferViewIndex,
  detachments: EditorBufferDetachments | undefined,
  before: Readonly<Record<string, string>> | undefined,
  after: Readonly<Record<string, string>> | undefined
): boolean {
  const cleared = (viewId: string | undefined): boolean =>
    viewId !== undefined && before?.[viewId] !== undefined && after?.[viewId] === undefined
  for (const [viewId, entry] of Object.entries(detachments ?? {})) {
    if (cleared(viewId) || cleared(index.editorBufferViews[entry.key]?.[0])) {
      return true
    }
  }
  return false
}

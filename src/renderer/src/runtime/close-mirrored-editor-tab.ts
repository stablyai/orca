import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import type { OpenFile } from '@/store/slices/editor'
import type { Tab } from '../../../shared/types'

export type MirroredEditorCloseState = WorktreeRuntimeOwnerState & {
  openFiles: readonly OpenFile[]
  unifiedTabsByWorktree: Record<string, Tab[]>
}

// Why: an editor file mirrored from a runtime session is owned by the host. The
// host republishes its open files to companions, so removing the tab only locally
// is undone by the next snapshot. Tell the host to close its own tab; the close
// intent recorded by the RPC suppresses re-mirroring until the snapshot catches up.
// Side-effecting only — callers still run their normal local close. No-op (returns
// false) for non-mirrored files, so the host's own closes are untouched.
export function notifyHostOfMirroredEditorClose(
  state: MirroredEditorCloseState,
  worktreeId: string | null | undefined,
  fileId: string
): boolean {
  if (!worktreeId) {
    return false
  }
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  if (!file?.mirroredFromRuntimeSession) {
    return false
  }
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (!runtimeEnvironmentId?.trim()) {
    return false
  }
  // Why: a mirrored editor unified tab carries the host's tab id as `id` and the
  // local file id as `entityId`, and the host close RPC resolves editor tabs by id.
  const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'editor' && tab.entityId === fileId
  )
  if (!unifiedTab) {
    return false
  }
  // Why: this helper is imported by the editor slice during store creation.
  // Importing web-runtime-session eagerly would import the store back and can
  // trip cyclic initialization in full-suite test/import order.
  void import('./web-runtime-session').then(({ closeWebRuntimeSessionTab }) =>
    closeWebRuntimeSessionTab({
      worktreeId,
      tabId: unifiedTab.id,
      environmentId: runtimeEnvironmentId
    })
  )
  return true
}

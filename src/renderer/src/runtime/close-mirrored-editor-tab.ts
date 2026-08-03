import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { recordWebSessionCloseIntent } from './web-session-close-intent'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import type { OpenFile } from '@/store/slices/editor'
import type { Tab } from '../../../shared/types'

export type MirroredEditorCloseState = WorktreeRuntimeOwnerState & {
  openFiles: readonly OpenFile[]
  unifiedTabsByWorktree: Record<string, Tab[]>
}

// A mirrored editor file is owned by the host, which republishes its open files, so a local-only close is undone by the next
// snapshot. Tell the host to close its own tab; the RPC's close intent suppresses re-mirroring until the snapshot catches up.
// Side-effecting only (callers still run their local close); no-op for non-mirrored files, so the host's own closes are untouched.
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
  // A mirrored unified tab carries the host's tab id as `id` and the local file id as `entityId`; the host close RPC resolves by id.
  const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'editor' && tab.entityId === fileId
  )
  if (!unifiedTab) {
    return false
  }
  // Record the close intent SYNCHRONOUSLY so a host snapshot landing before the dynamic import below resolves can't
  // flash the old-path tab back. closeWebRuntimeSessionTab re-records it idempotently.
  recordWebSessionCloseIntent(
    { environmentId: runtimeEnvironmentId },
    worktreeId,
    toHostSessionTabId(unifiedTab.id),
    Date.now()
  )
  // Dynamic import: this helper is imported by the editor slice during store creation, so importing
  // web-runtime-session eagerly imports the store back and trips cyclic init in full-suite import order.
  void import('./web-runtime-session').then(({ closeWebRuntimeSessionTab }) =>
    closeWebRuntimeSessionTab({
      worktreeId,
      tabId: unifiedTab.id,
      environmentId: runtimeEnvironmentId,
      reason: 'user'
    })
  )
  return true
}

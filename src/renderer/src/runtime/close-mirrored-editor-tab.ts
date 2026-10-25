import { runtimeEnvironmentIdUnlessTwin } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { recordWebSessionCloseIntent } from './web-session-close-intent'
import { isServerFrameDrawnWorkspace } from './web-session-tabs-sync/frame-drawn-server-workspace-set'
import { toHostSessionTabId } from '../../../shared/terminal-surface-id'
import type { OpenFile } from '@/store/slices/editor'
import type { Tab } from '../../../shared/tab-types'

export type MirroredEditorCloseState = WorktreeOperationRouteState & {
  openFiles: readonly OpenFile[]
  unifiedTabsByWorktree: Record<string, Tab[]>
}

// A mirrored editor file is owned by the host, which republishes its open files, so a local-only close is undone by the next
// snapshot. Tell the host to close its own tab; the RPC's close intent suppresses re-mirroring until the snapshot catches up.
// Side-effecting only (callers still run their local close); no-op for a file neither mirrored nor in a workspace a
// server's frames draw, so the host's own closes are untouched.
export function notifyHostOfMirroredEditorClose(
  state: MirroredEditorCloseState,
  worktreeId: string | null | undefined,
  fileId: string
): boolean {
  if (!worktreeId) {
    return false
  }
  const file = state.openFiles.find((candidate) => candidate.id === fileId)
  // A server's frames list only its own tabs, so every editor tab they draw is the server's.
  const frameDrawn =
    file?.runtimeEnvironmentId != null &&
    isServerFrameDrawnWorkspace(file.runtimeEnvironmentId, worktreeId)
  if (!file || (!file.mirroredFromRuntimeSession && !frameDrawn)) {
    return false
  }
  // Only legacy records need catalog inference; snapshots capture their authoritative runtime owner.
  const runtimeEnvironmentId =
    file.runtimeEnvironmentId === undefined
      ? // Why: closing on a guessed twin would retire the other host's tab; the local close still runs.
        runtimeEnvironmentIdUnlessTwin(state, worktreeId, 'close a mirrored editor tab on its host')
      : file.runtimeEnvironmentId
  if (!runtimeEnvironmentId?.trim()) {
    return false
  }
  // A mirrored unified tab carries the host's tab id as `id` and the local file id as `entityId`; the host close RPC resolves by id.
  const unifiedTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.contentType === 'editor' && tab.entityId === fileId
  )
  if (unifiedTabs.length === 0) {
    return false
  }
  // Record the close intent SYNCHRONOUSLY so a host snapshot landing before the dynamic import below resolves can't
  // flash the old-path tab back. closeWebRuntimeSessionTab re-records it idempotently.
  // Frames drop a closed tab themselves; the mirror's intent ledger skips a frame-drawn workspace.
  for (const tab of frameDrawn ? [] : unifiedTabs) {
    recordWebSessionCloseIntent(
      { environmentId: runtimeEnvironmentId },
      worktreeId,
      toHostSessionTabId(tab.id),
      Date.now()
    )
  }
  // Dynamic import: this helper is imported by the editor slice during store creation, so importing
  // web-runtime-session eagerly imports the store back and trips cyclic init in full-suite import order.
  void import('./web-runtime-session-tab-lifecycle').then(({ closeWebRuntimeSessionTab }) =>
    Promise.all(
      unifiedTabs.map((tab) =>
        closeWebRuntimeSessionTab({
          worktreeId,
          tabId: tab.id,
          environmentId: runtimeEnvironmentId,
          reason: 'user'
        })
      )
    )
  )
  return true
}

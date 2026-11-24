import { useAppStore } from '@/store/index'
import type { PersistedOpenFile } from '../../../../../../shared/workspace-session/workspace-session-state-types'
import type { ClosedUnsavedFile } from '@/store/slices/worktrees/teardown/removed-workspace-unsaved-files'
import { reopenClosedUnsavedFiles } from './closed-unsaved-files-toast'

let moving = false
let rerunRequested = false
let unsubscribe: (() => void) | null = null

/** Moves drafts of workspaces gone at startup into dirty untitled tabs of the active workspace, the common hot-exit pattern; failures stay stranded and retry when the active workspace, its host or a host connection changes. */
export function recoverStrandedEditorDrafts(): void {
  if (Object.keys(useAppStore.getState().strandedEditorDrafts).length === 0) {
    return
  }
  void moveStrandedDrafts()
  if (!unsubscribe) {
    unsubscribe = useAppStore.subscribe((state, prev) => {
      if (
        state.activeWorktreeId !== prev.activeWorktreeId ||
        state.activeWorkspaceExecutionHostId !== prev.activeWorkspaceExecutionHostId ||
        state.sshConnectionStates !== prev.sshConnectionStates ||
        state.sshStateByEnvironment !== prev.sshStateByEnvironment
      ) {
        void moveStrandedDrafts()
      }
    })
  }
}

async function moveStrandedDrafts(): Promise<void> {
  const state = useAppStore.getState()
  if (moving) {
    rerunRequested = true
    return
  }
  if (!state.activeWorktreeId) {
    return
  }
  moving = true
  rerunRequested = false
  try {
    const drafted = new Map<ClosedUnsavedFile, PersistedOpenFile>()
    for (const [ownerKey, drafts] of Object.entries(state.strandedEditorDrafts)) {
      for (const draft of drafts) {
        if (draft.dirtyDraftContent !== undefined) {
          const file = {
            fileId: `${ownerKey}:${draft.filePath}`,
            filePath: draft.filePath,
            content: draft.dirtyDraftContent
          }
          drafted.set(file, draft)
        }
      }
    }
    const failed = new Set(
      await reopenClosedUnsavedFiles([...drafted.keys()], { asDirtyDrafts: true })
    )
    // Why only after the tab holds it: the live draft now persists, so the stranded copy may go.
    useAppStore
      .getState()
      .settleRecoveredStrandedEditorDrafts(
        new Set([...drafted].flatMap(([file, draft]) => (failed.has(file) ? [] : [draft])))
      )
  } finally {
    moving = false
  }
  const after = useAppStore.getState()
  if (Object.keys(after.strandedEditorDrafts).length === 0) {
    unsubscribe?.()
    unsubscribe = null
  } else if (rerunRequested) {
    // A switch or connection change during the move was dropped by the in-flight guard.
    void moveStrandedDrafts()
  }
}

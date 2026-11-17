import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import type { WorktreePinnedDisplayName } from '../../../../shared/worktree/types'
import { useAppStore } from '../../store'
import { buildWorktreeMetaStateUpdate } from '@/store/slices/worktrees/metadata/worktree-meta-state-update'

/** Head-watcher branch patches keep fixed titles, so apply main's new pin before the re-list. */
export function applyLocalPinnedDisplayName(pin: WorktreePinnedDisplayName): void {
  useAppStore.setState((s) =>
    buildWorktreeMetaStateUpdate(s, {
      worktreeId: pin.worktreeId,
      updates: { displayName: pin.displayName, displayNameIsPinned: true },
      executionHostId: LOCAL_EXECUTION_HOST_ID
    })
  )
}

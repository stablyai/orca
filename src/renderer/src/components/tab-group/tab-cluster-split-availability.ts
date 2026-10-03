import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '../../runtime/web-runtime-session-environment'

export type TabClusterSplitBlocker = 'floating-panel' | 'remote-server'

/** Why a whole cluster can't move into a new split here, or null when it can. */
export function getTabClusterSplitBlocker(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): TabClusterSplitBlocker | null {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'floating-panel'
  }
  // Why: the single-tab mirror protocol cannot target the host's newly generated split pane id.
  return isWebRuntimeSessionActive(getRuntimeEnvironmentIdForWorktree(state, worktreeId))
    ? 'remote-server'
    : null
}

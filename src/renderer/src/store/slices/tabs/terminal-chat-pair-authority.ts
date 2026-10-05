import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'

/**
 * Who owns a worktree's per-tab chat pair, as seen by this desktop: `'local'` when this desktop is
 * the host and its store is the truth; `'legacy'` when a paired host owns it and this desktop
 * keeps its own per-pane copy.
 */
export type ChatPairAuthority = 'local' | 'legacy'

export function resolveChatPairAuthority(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): ChatPairAuthority {
  return getRuntimeEnvironmentIdForWorktree(state, worktreeId) ? 'legacy' : 'local'
}

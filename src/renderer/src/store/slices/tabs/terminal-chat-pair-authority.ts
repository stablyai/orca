import {
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'

/**
 * Who owns a worktree's per-tab chat pair, as seen by this desktop: `'local'` when this desktop is
 * the host and its store is the truth; `'host'` when a paired host's latest snapshot says it owns
 * the pair, so the store holds only host truth; `'legacy'` when an older paired host owns it and
 * this desktop keeps its own per-pane copy.
 */
export type ChatPairAuthority = 'local' | 'host' | 'legacy'

export type ChatPairAuthorityState = WorktreeRuntimeOwnerState & {
  chatViewHostOwnedByWorktree?: Record<string, true>
}

export function resolveChatPairAuthority(
  state: ChatPairAuthorityState,
  worktreeId: string
): ChatPairAuthority {
  if (!getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    return 'local'
  }
  return state.chatViewHostOwnedByWorktree?.[worktreeId] === true ? 'host' : 'legacy'
}

/**
 * True when the host turns this worktree's chat tabs to terminal on a proven agent exit and
 * refuses tagged chat writes after it: this desktop's own host (same build), or a paired host
 * that says so. Otherwise this desktop keeps its mounted pane's exit route.
 */
export function hostOwnsChatAgentExit(
  state: ChatPairAuthorityState & { chatViewAgentExitHostOwnedByWorktree?: Record<string, true> },
  worktreeId: string
): boolean {
  const authority = resolveChatPairAuthority(state, worktreeId)
  return (
    authority === 'local' ||
    (authority === 'host' && state.chatViewAgentExitHostOwnedByWorktree?.[worktreeId] === true)
  )
}

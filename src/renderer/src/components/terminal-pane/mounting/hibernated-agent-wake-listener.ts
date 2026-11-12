import type { IDisposable } from '@xterm/xterm'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'

type WakeablePaneBinding = IDisposable & {
  wakeHibernatedAgentIfArmed?: (claimedProviderSessions?: Set<string>) => string | null
}

/** Wakes this pane's armed hibernated agents when the worktree-wide wake event targets it. */
export function listenForHibernatedAgentWake(
  worktreeId: string,
  getBindings: () => Iterable<WakeablePaneBinding>
): () => void {
  const onWake = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return
    }
    const detail: WakeHibernatedAgentsWorktreeDetail | null = event.detail
    if (!detail || detail.worktreeId !== worktreeId) {
      return
    }
    for (const binding of getBindings()) {
      const claimKey = binding.wakeHibernatedAgentIfArmed?.(detail.wokenClaimKeys)
      if (claimKey) {
        detail.wokenClaimKeys?.add(claimKey)
      }
    }
  }
  window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
  return () => window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWake)
}

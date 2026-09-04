import type { IDisposable } from '@xterm/xterm'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'

type IDisposableWithWake = IDisposable & {
  wakeHibernatedAgentIfArmed?: (claimedProviderSessions?: Set<string>) => string | null
}

/**
 * One mounted pane's share of the hibernation-wake fanout: on the worktree's
 * wake event, every armed pty binding fires its cold-restore resume and
 * records its claim so the dispatcher's follow-up does not resume it twice.
 */
export function installTerminalPaneHibernationWakeListener(args: {
  worktreeId: string
  panePtyBindingsRef: React.RefObject<Map<number, IDisposable>>
}): () => void {
  const onWakeHibernatedAgents = (event: Event): void => {
    const detail = (event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail
    if (!detail || detail.worktreeId !== args.worktreeId) {
      return
    }
    for (const panePtyBinding of args.panePtyBindingsRef.current?.values() ?? []) {
      const claimKey = (panePtyBinding as IDisposableWithWake).wakeHibernatedAgentIfArmed?.(
        detail.wokenClaimKeys
      )
      if (claimKey) {
        detail.wokenClaimKeys?.add(claimKey)
      }
    }
  }
  window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
  return () =>
    window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
}

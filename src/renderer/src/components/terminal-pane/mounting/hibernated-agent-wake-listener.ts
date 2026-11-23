import type { IDisposable } from '@xterm/xterm'
import { registerHibernatedAgentWakeOwner } from '@/lib/agent-session/resume/hibernated-agent-wake-owners'

type WakeablePaneBinding = IDisposable & {
  wakeHibernatedAgentIfArmed?: (
    claimedProviderSessions?: Set<string>,
    paneKey?: string
  ) => string | null
}

/** Wakes this tab's armed hibernated agents when a wake targets its workspace or one of its panes. */
export function listenForHibernatedAgentWake(
  worktreeId: string,
  tabId: string,
  getBindings: () => Iterable<WakeablePaneBinding>
): () => void {
  return registerHibernatedAgentWakeOwner({
    worktreeId,
    tabId,
    wake: (detail) => {
      for (const binding of getBindings()) {
        const claimKey = binding.wakeHibernatedAgentIfArmed?.(detail.wokenClaimKeys, detail.paneKey)
        if (claimKey) {
          detail.wokenClaimKeys?.add(claimKey)
        }
      }
    }
  })
}

import type { IDisposable } from '@xterm/xterm'
import { registerHibernatedAgentWakeOwner } from '@/lib/agent-session/resume/hibernated-agent-wake-owners'
import { parsePaneKey } from '../../../../../shared/workspace-layout/stable-pane-id'

type WakeablePaneBinding = IDisposable & {
  wakeHibernatedAgentIfArmed?: (
    claimedProviderSessions?: Set<string>,
    paneKey?: string
  ) => string | null
}

/** Wakes this tab's armed hibernated agents when a wake targets its workspace, or the one pane a
 *  wake names, found by its leaf rather than by visiting the tab's other panes. */
export function listenForHibernatedAgentWake(
  worktreeId: string,
  tabId: string,
  getBindings: () => Iterable<WakeablePaneBinding>,
  getBindingForLeaf: (leafId: string) => WakeablePaneBinding | undefined
): () => void {
  return registerHibernatedAgentWakeOwner({
    worktreeId,
    tabId,
    wake: (detail) => {
      const leafId = detail.paneKey ? parsePaneKey(detail.paneKey)?.leafId : undefined
      const target = leafId ? getBindingForLeaf(leafId) : undefined
      for (const binding of detail.paneKey ? (target ? [target] : []) : getBindings()) {
        const claimKey = binding.wakeHibernatedAgentIfArmed?.(detail.wokenClaimKeys, detail.paneKey)
        if (claimKey) {
          detail.wokenClaimKeys?.add(claimKey)
        }
      }
    }
  })
}

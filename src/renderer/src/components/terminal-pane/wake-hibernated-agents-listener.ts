import type { IDisposable } from '@xterm/xterm'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'

type PaneBindingWithWake = IDisposable & {
  paneKey?: string
  wakeHibernatedAgentIfArmed?: (claimedProviderSessions?: Set<string>) => string | null
}

type WakeHibernatedAgentsListenerDeps = {
  worktreeId: string
  tabId: string
  getPanePtyBindings: () => Iterable<IDisposable>
}

/**
 * Registers the in-place hibernation wake listener for one mounted terminal
 * tab. Both the mobile worktree-open wake and the mail-driven slept-pane wake
 * dispatch this event; the listener and every dispatcher must share the event
 * constant — an inlined string silently severs them (that exact regression
 * shipped once as a colon-for-dash typo). Returns the cleanup, usable directly
 * as a useEffect body.
 */
export function installWakeHibernatedAgentsListener(
  deps: WakeHibernatedAgentsListenerDeps
): () => void {
  const onWakeHibernatedAgents = (event: Event): void => {
    const detail = (event as CustomEvent<WakeHibernatedAgentsWorktreeDetail>).detail
    if (!detail || detail.worktreeId !== deps.worktreeId) {
      return
    }
    // Why: a mail-driven wake targets one slept tab; an unscoped detail keeps
    // the mobile whole-worktree wake semantics.
    if (detail.tabId && detail.tabId !== deps.tabId) {
      return
    }
    for (const panePtyBinding of deps.getPanePtyBindings()) {
      const binding = panePtyBinding as PaneBindingWithWake
      if (detail.paneKey && binding.paneKey !== detail.paneKey) {
        continue
      }
      const claimKey = binding.wakeHibernatedAgentIfArmed?.(detail.wokenClaimKeys)
      if (claimKey) {
        detail.wokenClaimKeys?.add(claimKey)
      }
    }
  }
  window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
  return () =>
    window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
}

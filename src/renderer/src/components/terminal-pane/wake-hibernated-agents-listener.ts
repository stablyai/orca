import type { IDisposable } from '@xterm/xterm'
import {
  WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT,
  type WakeHibernatedAgentsWorktreeDetail
} from '@/constants/terminal'

type WakeablePaneBinding = IDisposable & {
  paneKey?: string
  wakeHibernatedAgentIfArmed: (claimedProviderSessions?: Set<string>) => string | null
}

type WakeHibernatedAgentsListenerDeps = {
  worktreeId: string
  tabId: string
  getPanePtyBindings: () => Iterable<IDisposable>
}

function isWakeDetail(value: unknown): value is WakeHibernatedAgentsWorktreeDetail {
  if (typeof value !== 'object' || value === null || !('worktreeId' in value)) {
    return false
  }
  const detail = value
  return (
    typeof detail.worktreeId === 'string' &&
    (!('tabId' in detail) || detail.tabId === undefined || typeof detail.tabId === 'string') &&
    (!('paneKey' in detail) ||
      detail.paneKey === undefined ||
      typeof detail.paneKey === 'string') &&
    (!('wokenClaimKeys' in detail) ||
      detail.wokenClaimKeys === undefined ||
      detail.wokenClaimKeys instanceof Set)
  )
}

function isWakeablePaneBinding(binding: IDisposable): binding is WakeablePaneBinding {
  return (
    'wakeHibernatedAgentIfArmed' in binding &&
    typeof binding.wakeHibernatedAgentIfArmed === 'function'
  )
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
    const detail = event instanceof CustomEvent ? event.detail : null
    if (!isWakeDetail(detail) || detail.worktreeId !== deps.worktreeId) {
      return
    }
    // Why: a mail-driven wake targets one slept tab; an unscoped detail keeps
    // the mobile whole-worktree wake semantics.
    if (detail.tabId && detail.tabId !== deps.tabId) {
      return
    }
    for (const panePtyBinding of deps.getPanePtyBindings()) {
      if (!isWakeablePaneBinding(panePtyBinding)) {
        continue
      }
      if (detail.paneKey && panePtyBinding.paneKey !== detail.paneKey) {
        continue
      }
      const claimKey = panePtyBinding.wakeHibernatedAgentIfArmed(detail.wokenClaimKeys)
      if (claimKey) {
        detail.wokenClaimKeys?.add(claimKey)
      }
    }
  }
  window.addEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
  return () =>
    window.removeEventListener(WAKE_HIBERNATED_AGENTS_WORKTREE_EVENT, onWakeHibernatedAgents)
}

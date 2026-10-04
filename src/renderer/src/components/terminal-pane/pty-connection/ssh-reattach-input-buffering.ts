import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Why: a remounted SSH pane takes focus as soon as it mounts, but its reattach to the
 * live remote shell takes a relay round trip; keys typed in between would be refused
 * and lost. Only a reattach buffers — typeahead into a fresh spawn could land ahead of
 * its startup command. Split panes already buffer for their own reason.
 */
export function buffersInputOnlyForSshReattach(session: ConnectPanePtySession): boolean {
  if (!session.connectionId || session.deps.cwdPromise || session.deps.preconnectInput?.length) {
    return false
  }
  return Boolean(
    session.restoredPtyIdForTransport ||
    session.tab?.ptyId ||
    session.state.deferredSshSessionIdsByTabId?.[session.deps.tabId]
  )
}

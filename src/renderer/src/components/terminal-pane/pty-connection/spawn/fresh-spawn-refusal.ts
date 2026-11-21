import { armPaneOwnerRetry, isPaneOwnerRefusal } from '../host-ownership/pane-owner-recovery'
import { NEWER_DAEMON_HOLD_ERROR } from '../../../../../../shared/terminal/daemon/newer-daemon-hold'
import { holdForNewerDaemon } from './newer-daemon-hold-pane'
import type { PendingStartupCommand } from '../startup/fresh-spawn-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

export type FreshSpawnRefusal = 'pane-owner' | 'newer-daemon'

/** Which refusal left a fresh spawn unbound, if any. */
export function freshSpawnRefusal(message: string): FreshSpawnRefusal | null {
  if (message.includes(NEWER_DAEMON_HOLD_ERROR)) {
    return 'newer-daemon'
  }
  return isPaneOwnerRefusal(message) ? 'pane-owner' : null
}

/** Reports a spawn error unless it is a newer-daemon hold, which the pane shows instead; returns its refusal. */
export function noteFreshSpawnError(
  session: ConnectPanePtySession,
  message: string
): FreshSpawnRefusal | null {
  const refusal = freshSpawnRefusal(message)
  if (refusal !== 'newer-daemon') {
    session.reportError(message)
  }
  return refusal
}

/** An owner refusal retries; a newer-daemon refusal waits read-only for Reopen, like a refused reattach. */
export function awaitSpawnRefusal(
  session: ConnectPanePtySession,
  refusal: FreshSpawnRefusal,
  generation: number,
  retry: () => Promise<string | null>,
  startupOverride: PendingStartupCommand | null | undefined
): void {
  if (refusal === 'newer-daemon') {
    // Main kept this pane's saved binding, which the renderer never had, so no saved screen paints.
    // Why no resumed count: a fresh start may drop its resume arguments and still return a PTY.
    const resumable = Boolean(startupOverride && 'launchConfig' in startupOverride)
    holdForNewerDaemon(session, null, resumable, async () => ({
      reopened: (await retry()) !== null,
      agentResumed: false
    }))
    return
  }
  armPaneOwnerRetry(session, generation, retry, startupOverride)
  session.settlePaneAttachAttempt?.('failed')
}

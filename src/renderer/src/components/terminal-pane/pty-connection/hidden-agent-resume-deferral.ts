import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime-pty-id'
import { takeSleepingAgentWakeRequest } from '@/lib/sleeping-agent-wake-requests'
import { holdPaneResumeUntilShown, releasePaneResumeHold } from '@/lib/pane-spawn-deferral-registry'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import { pendingSpawnByPaneKey } from './pty-connect-limits'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

/**
 * Holds a hidden pane's sleeping-agent resume until the pane is shown, by arming the same wake a
 * hibernated pane uses (#7145), so opening a workspace never resumes all its agents at once.
 * Returns false when the resume should start now: the pane is visible, or a background wake asked.
 */
export function deferHiddenAgentResume(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null,
  wake?: () => Promise<string | null>
): boolean {
  const recordEntry = startup?.sleepingRecordEntry
  if (
    !recordEntry ||
    session.disposed ||
    session.deps.isVisibleRef.current ||
    session.hiddenAgentResumeReleased
  ) {
    return false
  }
  if (takeSleepingAgentWakeRequest(recordEntry.record)) {
    // Why: later fallbacks in this same connect must not hold what the background wake released.
    session.hiddenAgentResumeReleased = true
    return false
  }
  const start: () => Promise<string | null> = wake ?? session.wakeHibernatedAgentPane
  const target = {
    // Why the current id: the wake must drop if another flow binds a PTY first.
    ptyId: session.transport.getPtyId(),
    record: recordEntry.record,
    wake: (): Promise<string | null> => {
      session.hiddenAgentResumeReleased = true
      return start().then((ptyId) => {
        // Why the transport: a held reattach resolves before it binds, and the hold must cover its fallback.
        if (
          session.transport.getPtyId() !== null &&
          session.hiddenAgentResumeHeldTarget === target
        ) {
          releaseHiddenAgentResumeHold(session)
        }
        return ptyId
      })
    }
  }
  session.hibernatedWakeTarget = target
  session.hiddenAgentResumeHeldTarget = target
  // Why: the cleared layout binding no longer proves ownership, so an activation sweep would relaunch the record.
  // Why each clause: armed, woken, or its reattach or fallback still connecting — until a PTY binds.
  session.hiddenAgentResumeHold ??= (): boolean =>
    !session.disposed &&
    session.hiddenAgentResumeHeldTarget !== null &&
    session.transport.getPtyId() === null &&
    (session.hibernatedWakeTarget === session.hiddenAgentResumeHeldTarget ||
      session.hibernatedWakeInFlightClaimKey !== null ||
      session.transportConnectInFlightSince !== null ||
      pendingSpawnByPaneKey.has(session.pendingSpawnKey))
  if (
    session.hiddenAgentResumeHoldKey &&
    session.hiddenAgentResumeHoldKey !== recordEntry.paneKey
  ) {
    releasePaneResumeHold(session.hiddenAgentResumeHoldKey, session.hiddenAgentResumeHold)
  }
  session.hiddenAgentResumeHoldKey = recordEntry.paneKey
  holdPaneResumeUntilShown(recordEntry.paneKey, session.hiddenAgentResumeHold)
  return true
}

/** Drops the pane's hold, at its wake or disposal; a later in-session sleep is not a held resume. */
export function releaseHiddenAgentResumeHold(session: ConnectPanePtySession): void {
  session.hiddenAgentResumeHeldTarget = null
  if (session.hiddenAgentResumeHold && session.hiddenAgentResumeHoldKey) {
    releasePaneResumeHold(session.hiddenAgentResumeHoldKey, session.hiddenAgentResumeHold)
  }
}

/** A pane whose process ended is asleep again: a background wake's release and any held resume are over. */
export function noteHiddenAgentResumePtyEnded(session: ConnectPanePtySession): void {
  session.hiddenAgentResumeReleased = false
  // Why: while the held wake is still armed nothing it started has run, so this exit is not its process.
  if (session.hibernatedWakeTarget !== session.hiddenAgentResumeHeldTarget) {
    releaseHiddenAgentResumeHold(session)
  }
}

/**
 * Reattaches a restored session, unless the pane is hidden and its host reports the session gone:
 * then the reattach would cold-restore the agent, so it waits for the pane to be shown instead.
 */
export function startDeferredSessionReattachUnlessHiddenAgentResume(
  session: ConnectPanePtySession,
  sessionId: string
): void {
  const reattach = (): void => startDeferredSessionReattach(session, sessionId)
  if (
    // Why local only: hasPty answers for this machine's providers; a paired host's id reads unverifiable.
    isRemoteRuntimePtyId(sessionId) ||
    session.runtimeEnvironmentId ||
    session.deps.isVisibleRef.current ||
    typeof window.api.pty.hasPty !== 'function' ||
    !session.buildColdRestoreAgentResumeStartup()?.sleepingRecordEntry
  ) {
    reattach()
    return
  }
  const generation = session.transportStreamGeneration
  void Promise.resolve(window.api.pty.hasPty(sessionId))
    .catch(() => null)
    .then((isLive) => {
      if (
        session.disposed ||
        generation !== session.transportStreamGeneration ||
        session.deps.paneTransportsRef.current.get(session.pane.id) !== session.transport
      ) {
        return
      }
      // Why only false: a live or unverifiable session must attach, and only the host's "exited" may hold it.
      const deferred =
        isLive === false &&
        deferHiddenAgentResume(session, session.buildColdRestoreAgentResumeStartup(), () => {
          reattach()
          return Promise.resolve(sessionId)
        })
      if (!deferred) {
        reattach()
      }
    })
}

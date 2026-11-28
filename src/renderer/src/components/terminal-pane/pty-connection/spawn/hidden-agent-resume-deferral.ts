import { isRemoteRuntimePtyId } from '../../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { takeSleepingAgentWakeRequest } from '@/lib/agent-session/resume/sleeping-agent-wake-requests'
import {
  holdPaneResumeUntilShown,
  releasePaneResumeHold
} from '@/components/terminal-pane/session-restore/spawn-deferral/pane-spawn-deferral-registry'
import { startDeferredSessionReattach } from '../reattach/deferred-session-reattach-connect'
import { pendingSpawnByPaneKey } from './pending-pane-spawn'
import type { ColdRestoreAgentResumeStartup } from '../startup/fresh-spawn-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'

// Mirrors waitsForMainPaneStart: main's start-to-attach window has no renderer connect in flight.
const mainPaneStartInFlight = (paneKey: string): boolean => {
  const status = useAppStore.getState().terminalPaneStartsByPaneKey[paneKey]?.status
  return status === 'starting' || status === 'resuming' || status === 'failed'
}

/** The pane is running its own resume and has not bound a PTY yet, so it owns its record meanwhile. */
const paneResumeAttemptInFlight = (session: ConnectPanePtySession): boolean =>
  !session.disposed &&
  session.transport.getPtyId() === null &&
  (session.transportConnectInFlightSince !== null ||
    pendingSpawnByPaneKey.has(session.pendingSpawnKey) ||
    // The flag covers dispatch before any status; cacheKey is the stable key main publishes under.
    session.mainPaneStartRequestInFlight ||
    mainPaneStartInFlight(session.cacheKey))

/** Holds the record until this pane's attempt settles, so the sweep cannot fork a duplicate tab. */
const holdPaneResumeAttempt = (session: ConnectPanePtySession, paneKey: string): void => {
  if (session.agentResumeAttemptHold && session.agentResumeAttemptHoldPaneKey === paneKey) {
    return
  }
  if (session.agentResumeAttemptHold && session.agentResumeAttemptHoldPaneKey) {
    releasePaneResumeHold(session.agentResumeAttemptHoldPaneKey, session.agentResumeAttemptHold)
  }
  const hold = (): boolean => {
    const inFlight = paneResumeAttemptInFlight(session)
    if (!inFlight) {
      releasePaneResumeHold(paneKey, hold)
      // A self-released hold must stop matching, or this pane's next attempt never re-registers.
      if (session.agentResumeAttemptHold === hold) {
        session.agentResumeAttemptHold = null
        session.agentResumeAttemptHoldPaneKey = null
      }
    }
    return inFlight
  }
  session.agentResumeAttemptHold = hold
  session.agentResumeAttemptHoldPaneKey = paneKey
  holdPaneResumeUntilShown(paneKey, hold)
}

/** Defer hidden restores through the hibernation wake until reveal; visible panes and explicit background wakes run immediately (#7145). */
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
    if (recordEntry && (session.disposed || session.deps.isVisibleRef.current)) {
      // No hidden deferral will spend this mark, and a stale mark would read as ownership forever.
      if (takeSleepingAgentWakeRequest(recordEntry.record)) {
        session.hiddenAgentResumeReleased = true
      }
      if (!session.disposed) {
        holdPaneResumeAttempt(session, recordEntry.paneKey)
      }
    }
    return false
  }
  if (takeSleepingAgentWakeRequest(recordEntry.record)) {
    // Why: later fallbacks in this same connect must not hold what the background wake released.
    session.hiddenAgentResumeReleased = true
    // The restore starts async through main; until a PTY binds, the sweep would fork a duplicate.
    holdPaneResumeAttempt(session, recordEntry.paneKey)
    return false
  }
  const start: () => Promise<string | null> = wake ?? session.wakeHibernatedAgentPane
  const target = {
    // Why the current id: the wake must drop if another flow binds a PTY first.
    ptyId: session.transport.getPtyId(),
    record: recordEntry.record,
    wake: (): Promise<string | null> => {
      if (startup?.resumeSource?.cancelled) {
        return Promise.resolve(null)
      }
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
  // Retain record ownership while armed, woken or connecting; cleared layout bindings alone would let activation launch a duplicate.
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
  // The hidden flow can't see the attempt's own hold; left in place it pins the session graph.
  if (session.agentResumeAttemptHold && session.agentResumeAttemptHoldPaneKey) {
    releasePaneResumeHold(session.agentResumeAttemptHoldPaneKey, session.agentResumeAttemptHold)
    session.agentResumeAttemptHold = null
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

/** Wait for reveal only when the host proves a hidden session gone; live and unverifiable sessions still reattach. */
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
          // Why: hidden, the gone session's reattach starts nothing, so a background wake resumes the agent itself.
          if (!session.deps.isVisibleRef.current && session.wakeHibernatedAgentPane) {
            return session.wakeHibernatedAgentPane()
          }
          reattach()
          return Promise.resolve(sessionId)
        })
      if (!deferred) {
        reattach()
      }
    })
}

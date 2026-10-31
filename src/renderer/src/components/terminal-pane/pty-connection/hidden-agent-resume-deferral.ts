import { isRemoteRuntimePtyId } from '../../../../../shared/remote-runtime/remote-runtime-pty-id'
import { useAppStore } from '@/store'
import { takeSleepingAgentWakeRequest } from '@/lib/sleeping-agent-wake-requests'
import { holdPaneResumeUntilShown, releasePaneResumeHold } from '@/lib/pane-spawn-deferral-registry'
import { startDeferredSessionReattach } from './deferred-session-reattach-connect'
import { pendingSpawnByPaneKey } from './pty-connect-limits'
import type { ColdRestoreAgentResumeStartup } from './fresh-spawn-types'
import type { ConnectPanePtySession } from './connect-pane-pty-session'

// Mirrors waitsForMainPaneStart's gate: these statuses span main's start of the pane through its
// asynchronous attach-back, a window with no renderer connect or spawn in flight.
const mainPaneStartInFlight = (paneKey: string): boolean => {
  const status = useAppStore.getState().terminalPaneStartsByPaneKey[paneKey]?.status
  return status === 'starting' || status === 'resuming' || status === 'failed'
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
      // Why consume: a disposed or visible pane never takes the hidden-deferral path, so nothing
      // would ever spend its wake mark — a later sweep would then read the stale mark as ownership
      // and skip a record whose pane has no live PTY and no resume in flight.
      if (takeSleepingAgentWakeRequest(recordEntry.record)) {
        session.hiddenAgentResumeReleased = true
      }
      if (!session.disposed) {
        // Why the hold: the visible restore runs async after this bypass, and before it binds a
        // PTY the sweep would see no mark, no live PTY and fork a duplicate. The predicate owns
        // exactly the attempt's in-flight window, self-releases once it reads false, and is also
        // tracked for releaseHiddenAgentResumeHold so a disposed pane cannot pin its session graph.
        const paneKey = recordEntry.paneKey
        const visibleHold = (): boolean => {
          const inFlight =
            !session.disposed &&
            session.transport.getPtyId() === null &&
            (session.transportConnectInFlightSince !== null ||
              pendingSpawnByPaneKey.has(session.pendingSpawnKey) ||
              mainPaneStartInFlight(paneKey))
          if (!inFlight) {
            releasePaneResumeHold(paneKey, visibleHold)
          }
          return inFlight
        }
        session.visibleAgentResumeHold = visibleHold
        session.visibleAgentResumeHoldPaneKey = paneKey
        holdPaneResumeUntilShown(paneKey, visibleHold)
      }
    }
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
  // The visible bypass's attempt hold is anonymous to the hidden flow; drop it here too or the
  // registry entry pins the pane's session graph until its pane key is reused.
  if (session.visibleAgentResumeHold && session.visibleAgentResumeHoldPaneKey) {
    releasePaneResumeHold(session.visibleAgentResumeHoldPaneKey, session.visibleAgentResumeHold)
    session.visibleAgentResumeHold = null
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
          reattach()
          return Promise.resolve(sessionId)
        })
      if (!deferred) {
        reattach()
      }
    })
}

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  runKillAllTerminalSurfaces,
  snapshotKillAllTerminalSurfaceIds,
  type KillAllTerminalSurfacesSummary
} from '@/components/shared/kill-all-terminal-surfaces'
import { waitForWorkspaceSessionReady } from '@/lib/worktree-agent-activation-gate'
import { useAppStore } from '../../store'

let stopAllInFlight = false

function showStopAllFailure(): void {
  toast.error(
    translate(
      'quitAndStopAllSessions.failed',
      "Couldn't stop every terminal session, so Orca stayed open."
    )
  )
}

// Why stricter than a Settings warning: quitting past any of these would leave a tab or session
// that comes back, or keeps running, after Orca exits.
function stoppedEverySession(summary: KillAllTerminalSurfacesSummary): boolean {
  return (
    summary.daemon.status === 'fulfilled' &&
    summary.daemon.remainingCount === 0 &&
    !summary.daemon.listingIncomplete &&
    summary.failedCloseAttemptCount === 0 &&
    summary.exactKillRejectedCount === 0
  )
}

// Why Settings' Kill all sessions: it retires the tabs too, so nothing reopens or resumes them
// on next launch, and it sweeps every daemon generation.
async function stopAllSessionsThenQuit(): Promise<void> {
  if (stopAllInFlight) {
    return
  }
  stopAllInFlight = true
  // Why: the ready gate and daemon polls can take tens of seconds after the user confirmed.
  const progressToastId = toast.loading(
    translate('quitAndStopAllSessions.stopping', 'Stopping terminal sessions, then quitting…')
  )
  try {
    // Why hydration too: closed tabs are only persisted once the session restore succeeded.
    const ready = await waitForWorkspaceSessionReady()
    const { hydrationSucceeded } = useAppStore.getState()
    if (!ready || !hydrationSucceeded) {
      console.warn('[quit-and-stop-all-sessions] Workspace session not ready:', {
        ready,
        hydrationSucceeded
      })
      showStopAllFailure()
      return
    }
    const summary = await runKillAllTerminalSurfaces(snapshotKillAllTerminalSurfaceIds())
    if (!stoppedEverySession(summary)) {
      showStopAllFailure()
      return
    }
    // Why re-read: Kill all covers only its snapshot, and a tab opened meanwhile would outlive the quit.
    const leftoverTabIds = snapshotKillAllTerminalSurfaceIds()
    if (leftoverTabIds.length > 0) {
      console.warn(
        '[quit-and-stop-all-sessions] Terminal tabs opened during Kill all:',
        leftoverTabIds
      )
      showStopAllFailure()
      return
    }
    if ((await window.api.ui.quitAfterStoppingAllSessions?.()) === false) {
      console.warn(
        '[quit-and-stop-all-sessions] Main still lists a terminal session after Kill all'
      )
      showStopAllFailure()
    }
  } catch (error) {
    console.error('[quit-and-stop-all-sessions] Stopping sessions failed:', error)
    showStopAllFailure()
  } finally {
    toast.dismiss(progressToastId)
    stopAllInFlight = false
  }
}

// Why consume on every path: main pushes and also queues the request, so only one path may act on it.
function consumePendingRequest(): void {
  const pending = window.api.ui.consumePendingQuitAndStopAllSessions?.()
  if (!pending || typeof pending.then !== 'function') {
    return
  }
  void pending
    .then((requested) => {
      if (requested) {
        void stopAllSessionsThenQuit()
      }
    })
    .catch(() => {})
}

/** Main confirmed Quit Completely; stop every session here, then let main quit. */
export function registerQuitAndStopAllSessionsIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(window.api.ui.onQuitAndStopAllSessions?.(consumePendingRequest) ?? (() => {}))
  // Why: a window opened for the request can mount after main's push.
  consumePendingRequest()
}

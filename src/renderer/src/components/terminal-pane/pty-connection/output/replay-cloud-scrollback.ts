import { keepDeeperHistoryAfterReplay } from '@/lib/orca-cloud/cloud-replay-depth-guard'
import {
  abandonWakeScrollbackRestore,
  beginWakeScrollbackRestore,
  finishWakeScrollbackRestore,
  HOLD_RENDER_UNTIL_RESTORED,
  noteBeforeCloudReplay,
  RELEASE_RENDER,
  settleWakeScrollbackRestore,
  type WakeScrollbackRestore
} from '@/lib/orca-cloud/cloud-wake-scrollback'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { keepWakeScrollPlace } from './wake-scroll-place'

/** Cloud scrollback kept across a clearing replay: the pre-replay pane copy and a woken pane's pre-sleep output. */
export type CloudReplayScrollback = {
  ptyId: string
  preSleep: WakeScrollbackRestore | null
  paneCopyKept: boolean
}

/**
 * Before a clearing replay. Resolves null when the payload went stale while keeping the pane copy.
 */
export async function beginCloudReplayScrollback(
  session: ConnectPanePtySession,
  ptyId: string,
  isCurrentPayload: () => boolean
): Promise<CloudReplayScrollback | null> {
  let paneCopyKept = false
  // A resubscribe keeps only the host's 1000 rows; keep the fuller copy first
  // in case a sleep nobody clicked here follows (a teammate, idle auto-sleep).
  const keptBeforeReplay = noteBeforeCloudReplay(session.pane.leafId, session.pane.terminal, ptyId)
  if (keptBeforeReplay) {
    paneCopyKept = true
    await keptBeforeReplay
    if (!isCurrentPayload()) {
      return null
    }
  }
  // A woken cloud pane's pre-sleep output, put back once this snapshot painted.
  const preSleep = beginWakeScrollbackRestore(
    session.pane.leafId,
    session.pane.terminal,
    Date.now(),
    ptyId
  )
  return { ptyId, preSleep, paneCopyKept }
}

/** Suffix for the replay's clearing preamble: holds rendering while pre-sleep output is restored. */
export function cloudReplayHoldRender(scrollback: CloudReplayScrollback | null): string {
  return scrollback?.preSleep ? HOLD_RENDER_UNTIL_RESTORED : ''
}

/** After the replay painted. Resolves false when the payload went stale meanwhile. */
export async function finishCloudReplayScrollback(
  session: ConnectPanePtySession,
  scrollback: CloudReplayScrollback | null,
  isCurrentPayload: () => boolean
): Promise<boolean> {
  if (!scrollback) {
    return true
  }
  const { ptyId, preSleep, paneCopyKept } = scrollback
  // A shallower replay of the same terminal never shrinks the pane's history.
  if (!preSleep && paneCopyKept) {
    await keepDeeperHistoryAfterReplay(
      session.pane.leafId,
      session.pane.terminal,
      ptyId,
      session.writeReplayDataAsync
    )
    if (!isCurrentPayload()) {
      return false
    }
  }
  if (preSleep) {
    const terminal = session.pane.terminal
    await finishWakeScrollbackRestore(
      preSleep,
      terminal,
      session.writeReplayDataAsync,
      keepWakeScrollPlace(terminal)
    )
    if (!isCurrentPayload()) {
      return false
    }
  }
  return true
}

/** The payload painted completely: its pre-sleep restore is done for good. */
export function settleCloudReplayScrollback(scrollback: CloudReplayScrollback | null): void {
  if (scrollback?.preSleep) {
    settleWakeScrollbackRestore(scrollback.preSleep)
  }
}

/**
 * The payload went stale after it took the pre-sleep restore: put the capture back for the next
 * snapshot and release the render hold its preamble may have set, so the pane never sits blank.
 */
export function abandonCloudReplayScrollback(
  session: ConnectPanePtySession,
  scrollback: CloudReplayScrollback | null
): void {
  if (!scrollback?.preSleep) {
    return
  }
  abandonWakeScrollbackRestore(scrollback.preSleep)
  void session.writeReplayDataAsync(RELEASE_RENDER).catch(() => undefined)
}

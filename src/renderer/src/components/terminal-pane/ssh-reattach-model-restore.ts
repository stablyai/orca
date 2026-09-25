import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'

export type SshReattachPaintSource = 'main-model-snapshot' | 'relay-replay'

export type SshReattachModelSnapshot = {
  data: string
  source?: 'headless' | 'renderer'
  scrollbackAnsi?: string
  pendingEscapeTailAnsi?: string
}

// Why: relay replay is already available during reattach; a stalled model
// probe must not strand that fallback or hold live PTY bytes indefinitely.
export const SSH_REATTACH_MODEL_SNAPSHOT_TIMEOUT_MS = 750

export async function resolveSshReattachModelSnapshotWithTimeout<T>(
  snapshot: Promise<T>,
  timeoutMs = SSH_REATTACH_MODEL_SNAPSHOT_TIMEOUT_MS
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    return await Promise.race([
      snapshot.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs)
      })
    ])
  } finally {
    if (timer !== null) {
      clearTimeout(timer)
    }
  }
}

/**
 * Which payload paints an SSH reattach (C1 SSH-parking design gate). Only
 * main's headless model is trusted: a 'renderer'-sourced snapshot serializes a
 * mounted xterm, which no longer exists once the pane parked — anything but a
 * non-empty headless snapshot degrades to the relay replay, never a blank paint.
 * Emptiness is judged on the composed CONTENT (scrollback + screen): an
 * alt-screen snapshot can carry all content in scrollbackAnsi with an empty
 * screen frame.
 */
export function decideSshReattachPaintSource(args: {
  ptyId: string
  sshParkingEnabled: boolean
  snapshot: SshReattachModelSnapshot | null
}): SshReattachPaintSource {
  if (!args.sshParkingEnabled || parseAppSshPtyId(args.ptyId) === null) {
    return 'relay-replay'
  }
  if (!args.snapshot || args.snapshot.source !== 'headless') {
    return 'relay-replay'
  }
  // Why the escape tail is excluded: a dangling mid-escape is not content — a
  // model holding only one paints a blank pane, which this gate forbids.
  // Accepted cost: a session that wrote only control-sequence preamble before
  // parking always falls back to relay; the gate cannot tell it apart from a
  // model that never received content, and relay replays that preamble anyway.
  const contentLength = (args.snapshot.scrollbackAnsi?.length ?? 0) + args.snapshot.data.length
  return contentLength === 0 ? 'relay-replay' : 'main-model-snapshot'
}

const ESCAPE = String.fromCharCode(27)
/** Matches a private-mode set/reset once the leading ESC has been split away. */
const PRIVATE_MODE_SEQUENCE = /^\[\?([0-9;]*)([hl])/
/** 47 and 1047 count alongside 1049: older apps still use them. */
const ALTERNATE_SCREEN_MODES = new Set(['47', '1047', '1049'])

/**
 * The last alternate-screen transition in a relay replay, or null if it holds none.
 *
 * A reconnect replay is the ONLY record of what happened while the client was gone — main's model
 * never saw those bytes — so it is the authority on which screen the app is on now, however stale
 * the rest of it is. 47 and 1047 count alongside 1049: older apps still use them, and any of the
 * three leaving reset means the frame is gone.
 */
export function lastAlternateScreenTransition(
  replay: string | undefined
): 'entered' | 'exited' | null {
  if (!replay) {
    return null
  }
  let transition: 'entered' | 'exited' | null = null
  // Split on ESC rather than matching it. Every private-mode sequence begins immediately after one,
  // so the two are equivalent — and no-control-regex forbids the escape inside a pattern, which is
  // worth respecting rather than suppressing when the alternative reads no worse. A tail can begin
  // mid-escape, so the first chunk is ordinary text and simply fails to match.
  for (const chunk of replay.split(ESCAPE)) {
    const match = PRIVATE_MODE_SEQUENCE.exec(chunk)
    if (match?.[1].split(';').some((mode) => ALTERNATE_SCREEN_MODES.has(mode))) {
      transition = match[2] === 'h' ? 'entered' : 'exited'
    }
  }
  return transition
}

/**
 * Whether an SSH RECONNECT paints main's model instead of the relay tail.
 *
 * Only for a full-screen app, and only when the replay does not contradict the model. A tail cannot
 * rebuild a frame whose start it no longer contains, while a grid can; a scrolling shell is the
 * opposite, since the tail holds outage output the model never saw and the grid would drop it.
 *
 * The `exited` veto is the case this gate exists to refuse: if the app left the alternate screen
 * while the client was gone, the model still reports alternateScreen because it never consumed
 * those bytes. Painting it would freeze a frame of an application that no longer exists AND discard
 * the replay carrying the shell's real output — strictly worse than the fragments this fix targets.
 */
export function sshReconnectPaintsFromModel(args: {
  snapshot: { alternateScreen?: boolean } | null
  /**
   * Taken already-computed rather than as the replay itself: the caller has to ask the same question
   * earlier, to decide whether fetching a snapshot is worth its timeout at all. Scanning again here
   * meant splitting up to 100 KB per pane twice on every reconnect. `hasReplay` cannot be inferred
   * from the transition — a replay carrying no mode change and no replay at all are both null.
   */
  hasReplay: boolean
  replayTransition: 'entered' | 'exited' | null
  altFrameWouldBeSkipped: boolean
}): boolean {
  if (!args.snapshot?.alternateScreen) {
    return false
  }
  if (!args.hasReplay) {
    // Nothing to degrade to, so the vetoes below would only trade a stale frame for a blank one.
    return true
  }
  // The alt frame is dropped for a width mismatch, leaving a cleared screen the app must repaint.
  // A park could afford that with no tail to lose; here it would mean discarding a usable one.
  return !args.altFrameWouldBeSkipped && args.replayTransition !== 'exited'
}

/**
 * Skip the snapshot fetch entirely when the paint could never use it.
 *
 * DELIBERATE that terminalSshViewParking gates the reconnect repaint too, not just parking: it is
 * the kill switch for painting an SSH pane from main's model at all, and a reconnect does exactly
 * that from the same probe. Off means every SSH reattach degrades to the relay tail — the behavior
 * that predates this machinery, which is what an escape hatch should restore. The cost is that a
 * user who disables parking also loses the full-screen reconnect repaint.
 */
export function shouldFetchSshReattachModelSnapshot(args: {
  ptyId: string
  sshParkingEnabled: boolean
}): boolean {
  return args.sshParkingEnabled && parseAppSshPtyId(args.ptyId) !== null
}

/**
 * Single-flight memo for the reattach model probe: at most one
 * getMainBufferSnapshot per reattach attempt. A null prefetch is remembered so
 * the payload task never buys a second probe timeout — it paints relay instead.
 */
export function memoizeSshReattachModelSnapshotProbe<T>(
  probe: () => Promise<T | null>
): () => Promise<T | null> {
  let inFlight: Promise<T | null> | null = null
  return () => {
    inFlight ??= probe()
    return inFlight
  }
}

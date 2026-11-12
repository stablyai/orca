// N-02: a shallower replay of the same cloud terminal never shrinks the history its pane holds.
// A resubscribe or resync answers with the host's 1000-row cut and clears the pane first; when that
// cut overlaps what the pane held, the older lines above the overlap are written back above it,
// client-side only (nothing reaches the PTY). No overlap (the terminal moved on by more than the
// cut) leaves the host's image as it is: older lines without the ones between would mislead.
import {
  forgetPreReplayCopy,
  preReplayCopy,
  type composeWakeRestore
} from './cloud-wake-scrollback'
import { wakeAnchorText } from './cloud-wake-scroll-anchor'
import {
  renderBufferRows,
  sanitizeRestoredText,
  type RestoreBuffer
} from './cloud-wake-scrollback-render'

/** Lines of the replay's history that must match the pane's copy, in a row, to count as overlap. */
const ANCHOR_LINES = 3
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

/** How many of the pane's last lines before the divider may be prompts the host did not restore. */
const TRAILING_LINES_SKIPPED = 6

/**
 * The host restored the pre-sleep history into the woken terminal (V3-02 follow-up): its replay
 * then already holds the lines that end just above the pane's divider. The divider goes back where
 * those lines end; nothing is repeated. Pre-sleep lines older than the host's start come from the
 * pane. Null when the host holds none of the pre-sleep lines.
 */
function resumeHostAfterSleep(before: string[], dividerAt: number, host: string[]): string | null {
  const lowest = Math.max(ANCHOR_LINES, dividerAt - TRAILING_LINES_SKIPPED)
  for (let end = dividerAt; end >= lowest; end--) {
    const anchor = before.slice(end - ANCHOR_LINES, end).map(plain)
    if (anchor.every((line) => line === '')) {
      continue
    }
    for (let start = host.length - ANCHOR_LINES; start >= 0; start--) {
      if (!anchor.every((line, k) => plain(host[start + k]) === line)) {
        continue
      }
      let hostEnd = start + ANCHOR_LINES
      // The pre-sleep lines after the anchor (a prompt) the host restored too stay above the divider.
      while (
        end + (hostEnd - start - ANCHOR_LINES) < dividerAt &&
        hostEnd < host.length &&
        plain(host[hostEnd]) === plain(before[end + (hostEnd - start - ANCHOR_LINES)])
      ) {
        hostEnd++
      }
      const older = before.slice(0, Math.max(0, end - ANCHOR_LINES - start))
      return [...older, ...host.slice(0, hostEnd), before[dividerAt], ...host.slice(hostEnd)].join(
        '\r\n'
      )
    }
  }
  return null
}

/** The wake divider ("── Slept 2:02–2:31 PM ──" in any of its forms, or a bare rule). */
function isWakeDivider(line: string | undefined): boolean {
  return /^──( .+ ──|─*)$/.test(plain(line))
}

function plain(line: string | undefined): string {
  return (line ?? '').replace(SGR, '').trimEnd()
}

/**
 * The pane's history with the replay's laid over its tail: the older lines the replay dropped, then
 * the replay's own lines. Its first line may be the tail of a wrapped line, so the match starts at
 * its second line and the pane's whole line stands in for the first. Null when the replay is not
 * shallower or does not overlap.
 */
export function mergeDeeperHistory(paneCopy: string, replayHistory: string): string | null {
  const before = paneCopy.split('\r\n')
  const after = replayHistory.split('\r\n')
  // V3-02: output from before a sleep lives only in this pane (sleep stopped the host's processes).
  // A host replay never carries the wake divider, so everything up to it is kept, then the host's.
  let dividerAt = before.length - 1
  while (dividerAt >= 0 && !isWakeDivider(before[dividerAt])) {
    dividerAt--
  }
  if (dividerAt !== -1 && !after.some(isWakeDivider)) {
    const hostLines = after.length === 1 && plain(after[0]) === '' ? [] : after
    return (
      resumeHostAfterSleep(before, dividerAt, hostLines) ??
      [...before.slice(0, dividerAt + 1), ...hostLines].join('\r\n')
    )
  }
  if (after.length < ANCHOR_LINES + 1 || before.length <= after.length) {
    return null
  }
  const anchor = after.slice(1, 1 + ANCHOR_LINES).map(plain)
  if (anchor.every((line) => line === '')) {
    return null
  }
  // The latest match: repeated output above it stays where it was.
  for (let start = before.length - ANCHOR_LINES; start >= 2; start--) {
    if (anchor.every((line, k) => plain(before[start + k]) === line)) {
      return [...before.slice(0, start), ...after.slice(1)].join('\r\n')
    }
  }
  return null
}

type ReplayedTerminal = Parameters<typeof composeWakeRestore>[1] & {
  buffer: { active: RestoreBuffer }
}

/** The last row of the screen with text, or the cursor's row when below it (screen-relative). */
function lastScreenRow(terminal: ReplayedTerminal): number {
  const active = terminal.buffer.active
  for (let row = terminal.rows - 1; row > active.cursorY; row--) {
    if (wakeAnchorText(active, active.baseY + row) !== null) {
      return row
    }
  }
  return active.cursorY
}

/**
 * After a clearing replay painted: puts back the pane's deeper history when the replay cut it. The
 * host's whole image (history and screen) is compared, since its newest lines sit on the screen;
 * the rewrite ends on the screen's last row with the cursor back where the replay left it.
 */
export async function keepDeeperHistoryAfterReplay(
  leafId: string,
  terminal: ReplayedTerminal,
  ptyId: string,
  write: (data: string) => Promise<void>
): Promise<boolean> {
  const paneCopy = preReplayCopy(leafId, ptyId)
  const active = terminal.buffer.active
  if (paneCopy === null || active.type !== 'normal') {
    return false
  }
  const last = lastScreenRow(terminal)
  const history = renderBufferRows(active, 0, active.baseY)
  const screen = renderBufferRows(active, active.baseY, active.baseY + last + 1)
  const merged = mergeDeeperHistory(paneCopy, history === '' ? screen : `${history}\r\n${screen}`)
  if (merged === null) {
    return false
  }
  const up = last - active.cursorY
  const data = `\x1b[2J\x1b[3J\x1b[H\x1b[0m${sanitizeRestoredText(merged)}\x1b[0m${up > 0 ? `\x1b[${up}A` : ''}\x1b[${active.cursorX + 1}G`
  // The replay's image is read; drop its scrollback so the rewrite is the pane's only copy.
  terminal.clear?.()
  await write(data)
  forgetPreReplayCopy(leafId)
  return true
}

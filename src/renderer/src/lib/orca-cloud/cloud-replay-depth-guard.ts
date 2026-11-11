// N-02: a shallower replay of the same cloud terminal never shrinks the history its pane holds.
// A resubscribe or resync answers with the host's 1000-row cut and clears the pane first; when that
// cut overlaps what the pane held, the older lines above the overlap are written back above it,
// client-side only (nothing reaches the PTY). No overlap (the terminal moved on by more than the
// cut) leaves the host's image as it is: older lines without the ones between would mislead.
import { composeWakeRestore, forgetPreReplayCopy, preReplayCopy } from './cloud-wake-scrollback'
import {
  renderBufferRows,
  sanitizeRestoredText,
  type RestoreBuffer
} from './cloud-wake-scrollback-render'

/** Lines of the replay's history that must match the pane's copy, in a row, to count as overlap. */
const ANCHOR_LINES = 3
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

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

/** After a clearing replay painted: puts back the pane's deeper history when the replay cut it. */
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
  const merged = mergeDeeperHistory(paneCopy, renderBufferRows(active, 0, active.baseY))
  const data =
    merged === null
      ? null
      : composeWakeRestore(`\x1b[0m${sanitizeRestoredText(merged)}\x1b[0m`, terminal)
  if (data === null) {
    return false
  }
  // The replay's screen is read; drop its scrollback so the rewrite is the pane's only copy.
  terminal.clear?.()
  await write(data)
  forgetPreReplayCopy(leafId)
  return true
}

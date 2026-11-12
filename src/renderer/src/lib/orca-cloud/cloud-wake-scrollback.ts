// WAKE-SCROLLBACK: a cloud terminal pane keeps its pre-sleep output across a wake. Sleep reboots the
// VM and the woken pane attaches to a new terminal whose snapshot replay erases scrollback; the
// output the pane showed before the sleep is written back above a "Slept 14:02–14:31 · processes
// stopped" divider, client-side only (nothing reaches the PTY), as rendered text + SGR.
import { translate } from '@/i18n/i18n'
import { parseRemoteRuntimePtyId } from '../../../../shared/remote-runtime/remote-runtime-pty-id'
import { isOrcaCloudEnvironmentId } from './orca-cloud-environment-id'
import {
  formatSleptRange,
  renderBufferRows,
  renderBufferRowsAsync,
  sanitizeRestoredText,
  type RestoreBuffer
} from './cloud-wake-scrollback-render'

type PendingHistory = {
  /** Which sleep this is from (its start); one capture per sleep. */
  sleptAt: number
  /** Text + SGR (or plain text from the read-only copy); null until known, or when empty. */
  text: string | null
  /**
   * The workspace left "asleep": the next clearing replay is the woken terminal's. Until then a
   * replay (a cold restore while still asleep) must not take it.
   */
  armed: boolean
  /** The pre-sleep terminal: a snapshot for a different one belongs to the woken terminal. */
  ptyId: string | null
  /** The line the person had scrolled up to (kept across the wake's remount), or null at the bottom. */
  scrolledTo: number | null
}

/**
 * The pane just before a clearing replay of its own terminal (a resubscribe, e.g. while the VM
 * suspends): that replay keeps only the host's 1000 rows. One per pane, replaced, never piled up.
 */
type PreReplaySnapshot = { ptyId: string; at: number; aboveScreen: string; screen: string }
const preReplay = new Map<string, PreReplaySnapshot>()
/** The host's subscribe/recovery replay keeps this many rows of history. */
const HOST_REPLAY_ROWS = 1000
/** A sleep that follows a resubscribe within this long uses what the pane held before it. */
const PRE_REPLAY_MAX_AGE_MS = 10 * 60_000

// Keyed by the pane's durable leaf id; cleared once restored, or when the pane goes away.
const SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const pending = new Map<string, PendingHistory>()

export type ScrollbackSource = {
  rows: number
  buffer: {
    normal: RestoreBuffer & { baseY: number }
    active?: { viewportY: number; baseY: number }
  }
}

function lastTextRow(buffer: RestoreBuffer): number {
  for (let y = buffer.length - 1; y >= 0; y--) {
    const line = buffer.getLine(y)
    for (let x = 0; line && x < line.length; x++) {
      const chars = line.getCell(x)?.getChars() ?? ''
      if (chars !== '' && chars !== ' ') {
        return y
      }
    }
  }
  return -1
}

/**
 * While asleep (or waking), before the new terminal attaches: keep the pane's normal-buffer output.
 * A shell pane keeps its visible rows too (its last output is usually on screen); an agent or
 * full-screen pane keeps only the scrollback above its screen, so no frozen TUI frame comes back.
 * With nothing in the pane (never mounted, app or renderer restarted while asleep), the plain-text
 * read-only copy saved at sleep stands in, uncoloured.
 */
export function captureWakeScrollback(
  leafId: string,
  terminal: ScrollbackSource,
  options: {
    /** When the workspace went to sleep; null when unknown (the first capture's time stands in). */
    sleptAt: number | null
    agentPane: boolean
    maxRows: number
    readOnlyCopy?: () => Promise<readonly string[] | null>
    /** The pane's terminal before the sleep; a replay for any other one is the woken terminal's. */
    ptyId?: string | null
  }
): void {
  const existing = pending.get(leafId)
  // One capture per sleep, the earliest: by "asleep" the transport may already have resubscribed
  // and replaced the buffer with the host's 1000-row snapshot. A later look only refines the time.
  // An armed (woken) but untaken capture is a past sleep's; a new sleep captures afresh.
  if (existing && !existing.armed) {
    if (options.sleptAt !== null) {
      existing.sleptAt = options.sleptAt
    }
    return
  }
  const normal = terminal.buffer.normal
  const end = options.agentPane ? normal.baseY : lastTextRow(normal) + 1
  let text = renderBufferRows(normal, Math.max(0, end - options.maxRows), end)
  // A sleep nobody clicked here (a teammate, idle auto-sleep): the VM was already going down when
  // the pane heard, and a resubscribe may have cut it to the host's 1000 rows. What it held just
  // before that replay is the fuller copy.
  const before = preReplay.get(leafId)
  if (before && before.ptyId === options.ptyId && Date.now() - before.at < PRE_REPLAY_MAX_AGE_MS) {
    const fuller = options.agentPane
      ? before.aboveScreen
      : [before.aboveScreen, before.screen].filter((part) => part !== '').join('\r\n')
    if (fuller.split('\r\n').length > text.split('\r\n').length) {
      text = fuller.split('\r\n').slice(-options.maxRows).join('\r\n')
    }
  }
  preReplay.delete(leafId)
  const active = terminal.buffer.active
  const entry: PendingHistory = {
    sleptAt: options.sleptAt ?? Date.now(),
    armed: false,
    ptyId: options.ptyId ?? null,
    text: text.replace(SGR, '').trim() === '' ? null : text,
    scrolledTo: active && active.viewportY < active.baseY ? active.viewportY : null
  }
  pending.set(leafId, entry)
  if (entry.text !== null || !options.readOnlyCopy) {
    return
  }
  void options
    .readOnlyCopy()
    .then((lines) => {
      if (pending.get(leafId) !== entry || !lines) {
        return
      }
      const kept = options.agentPane
        ? lines.slice(0, Math.max(0, lines.length - terminal.rows))
        : lines
      const plain = kept.slice(-options.maxRows)
      entry.text = plain.join('').trim() === '' ? null : plain.join('\r\n')
    })
    .catch(() => undefined)
}

/**
 * The divider, dim, between the restored output and the woken terminal (WAKE-DIVIDER-WIDTH). It
 * never wraps: the longest form that fits the pane's columns when it is written, decided once —
 * "── Slept 2:02–2:31 PM · processes stopped ──", then "── Slept 2:02–2:31 PM ──", then
 * "── Slept ──", then a bare rule the pane's width. No ellipsis; the time range is never split.
 */
export function wakeDividerLine(sleptAt: number, wokeAt: number, cols = Infinity): string {
  const range = formatSleptRange(sleptAt, wokeAt)
  const labels = [
    translate(
      'orcaCloudWorkspace.terminal.sleptRangeDivider',
      'Slept {{range}} · processes stopped',
      {
        range
      }
    ),
    translate('orcaCloudWorkspace.terminal.sleptRangeShortDivider', 'Slept {{range}}', { range }),
    translate('orcaCloudWorkspace.terminal.sleptBareDivider', 'Slept')
  ]
  const fitting = labels.map((label) => `── ${label} ──`).find((form) => displayWidth(form) <= cols)
  return `\x1b[0;2m${fitting ?? '─'.repeat(Math.max(1, Math.floor(cols)))}\x1b[0m`
}

/** Columns a divider takes: one per code point (its text has no wide characters). */
export function displayWidth(text: string): number {
  return [...text].length
}

/** The workspace is waking or live: these panes' next clearing replay restores their output. */
export function armWakeScrollback(leafIds: Iterable<string>): void {
  for (const id of leafIds) {
    const entry = pending.get(id)
    if (entry) {
      entry.armed = true
    }
  }
}

/**
 * What a freshly mounted pane shows until its woken snapshot's restore: the kept output alone
 * (text + SGR only), or null when there is none.
 */
export function wakeScrollbackPreview(leafId: string): string | null {
  const text = pending.get(leafId)?.text ?? null
  return text === null ? null : `\x1b[0m${sanitizeRestoredText(text)}\x1b[0m`
}

/** The pane has pre-sleep output waiting to be put back after its wake. */
export function hasPendingWakeScrollback(leafId: string): boolean {
  return (pending.get(leafId)?.text ?? null) !== null
}

/** The pane closed or its workspace was deleted. */
export function forgetWakeScrollback(leafIds: Iterable<string>): void {
  for (const id of leafIds) {
    pending.delete(id)
    preReplay.delete(id)
  }
}

/**
 * Before a clearing replay on an Orca Cloud pane with no capture pending: keep what the pane holds,
 * if it holds more than the host's replay keeps. Rendered in chunks, off the input path.
 */
export function noteBeforeCloudReplay(
  leafId: string,
  terminal: ScrollbackSource,
  ptyId: string | null,
  isCloudPane: (ptyId: string) => boolean = (id) =>
    isOrcaCloudEnvironmentId(parseRemoteRuntimePtyId(id)?.environmentId ?? '')
): Promise<void> | null {
  // Decided synchronously, cheapest facts first: a skipped pane adds no await to the replay path.
  if (!ptyId || pending.has(leafId) || !isCloudPane(ptyId)) {
    return null
  }
  const normal = terminal.buffer?.normal
  if (!normal || normal.length - terminal.rows <= HOST_REPLAY_ROWS) {
    return null
  }
  return (async () => {
    const aboveScreen = await renderBufferRowsAsync(normal, 0, normal.baseY)
    const screen = renderBufferRows(normal, normal.baseY, lastTextRow(normal) + 1)
    preReplay.set(leafId, { ptyId, at: Date.now(), aboveScreen, screen })
  })()
}

/** N-02: what the pane held just before a clearing replay of this same terminal, or null. */
export function preReplayCopy(leafId: string, ptyId: string, maxAgeMs = 60_000): string | null {
  const before = preReplay.get(leafId)
  if (!before || before.ptyId !== ptyId || Date.now() - before.at > maxAgeMs) {
    return null
  }
  return [before.aboveScreen, before.screen].filter((part) => part !== '').join('\r\n')
}

/** The copy was put back: a later sleep reads the pane itself. */
export function forgetPreReplayCopy(leafId: string): void {
  preReplay.delete(leafId)
}

/** The person scrolled the waking pane: where to put them back after the restore. */
export function noteWakeViewport(
  leafId: string,
  terminal: { buffer: { active: { viewportY: number; baseY: number } } }
): void {
  const entry = pending.get(leafId)
  if (entry) {
    const { viewportY, baseY } = terminal.buffer.active
    entry.scrolledTo = viewportY < baseY ? viewportY : null
  }
}

type WokenTerminal = {
  rows: number
  /** The divider is fitted to these (WAKE-DIVIDER-WIDTH). */
  cols?: number
  buffer: {
    active: RestoreBuffer & {
      type: string
      viewportY: number
      baseY: number
      cursorX: number
      cursorY: number
    }
  }
  scrollToLine: (line: number) => void
  /** Drops the scrollback (xterm's own API; an ED3 sent through the replay writer may not). */
  clear?: () => void
}

/** A restore started on the woken terminal's snapshot, finished once that snapshot painted. */
export type WakeScrollbackRestore = {
  /** The restored output (text + SGR only) and its divider. */
  block: string
  /** Where a person who had scrolled up was, or null when pinned to the bottom. */
  scrolledTo: number | null
}

/**
 * The woken terminal's snapshot is about to paint: takes (and forgets) the pane's armed restore.
 * Null when there is none, or nothing to restore (then nothing is said either).
 */
export function beginWakeScrollbackRestore(
  leafId: string,
  terminal: WokenTerminal,
  wokeAt = Date.now(),
  /** The terminal this snapshot is for. */
  ptyId: string | null = null
): WakeScrollbackRestore | null {
  const entry = pending.get(leafId)
  // Armed by the workspace leaving "asleep", or (sooner, with no race against React) by the
  // snapshot being for a new terminal: a cold restore while asleep is for the old one.
  const newTerminal = entry?.ptyId != null && ptyId !== null && ptyId !== entry.ptyId
  if (!entry || !(entry.armed || newTerminal)) {
    return null
  }
  pending.delete(leafId)
  if (entry.text === null) {
    return null
  }
  const { viewportY, baseY } = terminal.buffer.active
  return {
    // A remount on wake starts at the bottom: the person's scroll is the one noted before it.
    scrolledTo: viewportY < baseY ? viewportY : entry.scrolledTo,
    block: `\x1b[0m${sanitizeRestoredText(entry.text)}\x1b[0m\r\n${wakeDividerLine(entry.sleptAt, wokeAt, terminal.cols)}`
  }
}

function rowHasText(buffer: RestoreBuffer, y: number): boolean {
  const line = buffer.getLine(y)
  for (let x = 0; line && x < line.length; x++) {
    const chars = line.getCell(x)?.getChars() ?? ''
    if (chars !== '' && chars !== ' ') {
      return true
    }
  }
  return false
}

/**
 * Appended to the snapshot's own clear when a restore follows: holds rendering (DEC 2026) from that
 * clear until the rewrite, so no frame shows a blank pane or the woken prompt without its history.
 */
export const HOLD_RENDER_UNTIL_RESTORED = '\x1b[?2026h'
const RELEASE_RENDER = '\x1b[?2026l'

/**
 * The client-side rewrite once the snapshot painted: the restored output, the divider, then the
 * woken screen's rows, with the cursor put back where the snapshot left it (relative moves only).
 * Null on the alternate screen (a full-screen app owns the pane; its normal buffer is not shown).
 */
export function composeWakeRestore(block: string, terminal: WokenTerminal): string | null {
  const active = terminal.buffer.active
  if (active.type !== 'normal') {
    return null
  }
  let last = active.cursorY
  for (let row = terminal.rows - 1; row > active.cursorY; row--) {
    if (rowHasText(active, active.baseY + row)) {
      last = row
      break
    }
  }
  const screen = renderBufferRows(active, active.baseY, active.baseY + last + 1)
  const up = last - active.cursorY
  return `\x1b[2J\x1b[3J\x1b[H${block}\r\n${screen}\x1b[0m${up > 0 ? `\x1b[${up}A` : ''}\x1b[${active.cursorX + 1}G`
}

/**
 * Writes the rewrite through `write` (the replay writer: client-side, under the replay guard;
 * nothing reaches the PTY). Stays pinned to the bottom; a person who had scrolled up keeps their place.
 */
export async function finishWakeScrollbackRestore(
  restore: WakeScrollbackRestore,
  terminal: WokenTerminal,
  write: (data: string) => Promise<void>,
  /** Puts the person back on their line; the pane may pass one that keeps its scroll intent in step. */
  scrollTo: (line: number) => void = (line) => terminal.scrollToLine(line)
): Promise<boolean> {
  const data = composeWakeRestore(restore.block, terminal)
  if (data !== null) {
    // The woken screen is read; drop everything above it (a remount's preview, the old image) so
    // the rewrite below is the pane's only copy of its history.
    terminal.clear?.()
  }
  // Always release the render hold, restored or not.
  await write(`${data ?? ''}${RELEASE_RENDER}`)
  if (data === null) {
    return false
  }
  if (restore.scrolledTo !== null) {
    scrollTo(restore.scrolledTo)
  }
  return true
}

/** Tests only. */
export function resetWakeScrollbackForTests(): void {
  pending.clear()
  preReplay.clear()
}

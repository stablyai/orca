// Share renderer-parity fixtures across main/renderer fuzz suites; their tsconfigs exclude each other’s sources.
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from './terminal-unicode-provider'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from './terminal-scrollback-policy'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from './terminal-serialize-absolute-cursor'
import {
  ABORT_TRUNCATED_CONTROL_STRING,
  buildSnapshotReplayPrologue
} from './terminal-mode-reset-profiles'

export type ParityTerminal = {
  terminal: Terminal
  serializeAddon: SerializeAddon
}

/** Match renderer buffer state: scrollback/Kitty options, Unicode11 and Orca ZWJ. Font/cursor/render options do not affect cells. */
export function createRendererParityTerminal(dims: { cols: number; rows: number }): ParityTerminal {
  const terminal = new Terminal({
    cols: dims.cols,
    rows: dims.rows,
    scrollback: DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
    allowProposedApi: true,
    vtExtensions: { kittyKeyboard: true }
  })
  const serializeAddon = new SerializeAddon()
  terminal.loadAddon(serializeAddon)
  terminal.loadAddon(new Unicode11Addon())
  activateOrcaTerminalUnicodeProvider(terminal)
  return { terminal, serializeAddon }
}

export function writeToTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve))
}

export function writeChunksToTerminal(terminal: Terminal, chunks: string[]): Promise<void> {
  return new Promise((resolve) => {
    if (chunks.length === 0) {
      resolve()
      return
    }
    // The final FIFO callback also fences async parser handlers in earlier chunks.
    for (let index = 0; index < chunks.length; index++) {
      terminal.write(chunks[index]!, index === chunks.length - 1 ? resolve : undefined)
    }
  })
}

/** Bottom-anchored visible screen rows (baseY, not viewportY — scroll intent
 *  is enforced separately by the production restore path). */
export function visibleRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  const rows: string[] = []
  for (let y = 0; y < terminal.rows; y++) {
    rows.push(buffer.getLine(buffer.baseY + y)?.translateToString(true) ?? '')
  }
  return rows
}

export function visibleRowWraps(terminal: Terminal): boolean[] {
  const buffer = terminal.buffer.active
  return Array.from({ length: terminal.rows }, (_, y) =>
    Boolean(buffer.getLine(buffer.baseY + y)?.isWrapped)
  )
}

// xterm attribute color modes (Attributes CM_* in xterm's buffer model).
const COLOR_MODE_P16 = 16777216
const COLOR_MODE_P256 = 33554432

/** SerializeAddon normalizes palette indices 0–15 from CM_P256 to CM_P16; both resolve to the same theme slots. */
function canonicalColorMode(mode: number, color: number): number {
  return mode === COLOR_MODE_P256 && color >= 0 && color < 16 ? COLOR_MODE_P16 : mode
}

/** Compare visually effective cell state even when text matches: glyph attributes, blank backgrounds and inverse foregrounds.
 * Keep space decorations; WebGL skips null-cell decorations, and serialization may turn null runs into spaces. Trim pristine trailing blanks the serializer omits. */
type TerminalBufferLine = ReturnType<Terminal['buffer']['active']['getLine']>

function effectiveRowStyles(line: TerminalBufferLine): string {
  const cells: string[] = []
  for (let x = 0; line && x < line.length; x++) {
    const cell = line.getCell(x)
    if (!cell) {
      continue
    }
    const chars = cell.getChars()
    const fgMode = canonicalColorMode(cell.getFgColorMode(), cell.getFgColor())
    const bgMode = canonicalColorMode(cell.getBgColorMode(), cell.getBgColor())
    if (chars === '' || chars === ' ') {
      const blankFlags = [
        chars === ' ' && cell.isUnderline(),
        chars === ' ' && cell.isStrikethrough(),
        chars === ' ' && cell.isOverline()
      ]
        .map((flag) => (flag ? '1' : '0'))
        .join('')
      const inverseFg = cell.isInverse() ? `·if${fgMode}:${cell.getFgColor()}` : ''
      cells.push(`▯·w${cell.getWidth()}·b${bgMode}:${cell.getBgColor()}·${blankFlags}${inverseFg}`)
      continue
    }
    const flags = [
      cell.isBold(),
      cell.isDim(),
      cell.isItalic(),
      cell.isUnderline(),
      cell.isInverse(),
      cell.isStrikethrough()
    ]
      .map((flag) => (flag ? '1' : '0'))
      .join('')
    cells.push(
      `${chars}·w${cell.getWidth()}·f${fgMode}:${cell.getFgColor()}·b${bgMode}:${cell.getBgColor()}·${flags}`
    )
  }
  const defaultBlank = `▯·w1·b0:-1·000`
  while (cells.length > 0 && cells.at(-1) === defaultBlank) {
    cells.pop()
  }
  return cells.join('|')
}

export function visibleRowStyles(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  return Array.from({ length: terminal.rows }, (_, y) =>
    effectiveRowStyles(buffer.getLine(buffer.baseY + y))
  )
}

export function cursorPosition(terminal: Terminal): { x: number; y: number } {
  return { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY }
}

/** Full normal-buffer text with trailing blank rows trimmed (SerializeAddon
 *  restores content rows; both sides may differ only in trailing blanks). */
export function normalBufferRowsTrimmed(terminal: Terminal): string[] {
  const buffer = terminal.buffer.normal
  const rows: string[] = []
  for (let y = 0; y < buffer.length; y++) {
    rows.push(buffer.getLine(y)?.translateToString(true) ?? '')
  }
  while (rows.length > 0 && rows.at(-1) === '') {
    rows.pop()
  }
  return rows
}

export function normalBufferStylesTrimmed(terminal: Terminal): string[] {
  const buffer = terminal.buffer.normal
  const rows = Array.from({ length: buffer.length }, (_, y) =>
    effectiveRowStyles(buffer.getLine(y))
  )
  while (rows.length > 0 && rows.at(-1) === '') {
    rows.pop()
  }
  return rows
}

// Reuse production preambles: duplicated pre-#14241 bytes invalidated fuzz/parity checks (#12101). Fresh harness terminals start on normal.
export const SNAPSHOT_REPLAY_PREAMBLE_NORMAL = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue(
  { targetAlternateScreen: false, paneOnAlternateScreen: false }
)}`
export const SNAPSHOT_REPLAY_PREAMBLE_ALT = `${ABORT_TRUNCATED_CONTROL_STRING}${buildSnapshotReplayPrologue(
  { targetAlternateScreen: true, paneOnAlternateScreen: false }
)}`

export { POST_REPLAY_LIVE_SNAPSHOT_RESET as POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY } from './terminal-mode-reset-profiles'

export type ParityMainSnapshot = {
  data: string
  scrollbackAnsi?: string
  cols: number
  rows: number
  seq: number
  alternateScreen: boolean
  pendingDeliveryStartSeq?: number
  /** Write the hidden stream’s incomplete escape last, after post-replay resets (Bug E). */
  pendingEscapeTailAnsi?: string
}

/** Mirror HeadlessEmulator snapshot composition and OrcaRuntime normal/alt separation; renderer fuzz cannot import main/daemon sources. */
export function buildParityMainBufferSnapshot(
  parity: ParityTerminal,
  seq: number,
  opts: {
    pendingDeliveryStartSeq?: number
    scrollbackRows?: number
    /** The hidden byte stream's trailing incomplete escape, exactly as the
     *  emulator's ingest tracker would have accumulated it. */
    pendingEscapeTail?: string
  } = {}
): ParityMainSnapshot {
  const { terminal } = parity
  const alternateScreen = terminal.buffer.active.type === 'alternate'
  const scrollback = opts.scrollbackRows ?? DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT
  // Match production absolute-cursor and DECSC epilogues.
  let snapshotAnsi = serializeWithAbsoluteCursor(
    parity.serializeAddon,
    terminal,
    { scrollback },
    readSavedCursorRegister(terminal)
  )
  let scrollbackAnsi: string | undefined
  if (alternateScreen) {
    // Production separates normal history from the active alt frame; rehydrateSequences owns the switch.
    const marker = '\x1b[?1049h'
    const start = snapshotAnsi.lastIndexOf(marker)
    if (start !== -1) {
      scrollbackAnsi = snapshotAnsi.slice(0, start)
      snapshotAnsi = snapshotAnsi.slice(start + marker.length)
    }
  }
  const seqs: string[] = []
  if (alternateScreen) {
    seqs.push('\x1b[0m\x1b[?1049h')
  }
  if (terminal.modes.bracketedPasteMode) {
    seqs.push('\x1b[?2004h')
  }
  // Match getModes: applicationCursor is false on alt, so alt snapshots omit ?1h.
  if (!alternateScreen && terminal.modes.applicationCursorKeysMode) {
    seqs.push('\x1b[?1h')
  }
  // Mouse reporting affects input encoding, not rendered output; omit it from visual parity.
  const snapshot: ParityMainSnapshot = {
    data: seqs.join('') + snapshotAnsi,
    cols: terminal.cols,
    rows: terminal.rows,
    seq,
    alternateScreen,
    ...(scrollbackAnsi !== undefined ? { scrollbackAnsi } : {})
  }
  if (opts.pendingDeliveryStartSeq !== undefined) {
    snapshot.pendingDeliveryStartSeq = opts.pendingDeliveryStartSeq
  }
  if (opts.pendingEscapeTail) {
    snapshot.pendingEscapeTailAnsi = opts.pendingEscapeTail
  }
  return snapshot
}

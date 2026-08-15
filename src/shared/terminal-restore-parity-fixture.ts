// Renderer-parity headless terminal + snapshot/replay mirrors for the garble
// differential fuzz suites (headless-emulator-fidelity.fuzz.test.ts and
// hidden-reveal-reconciliation.fuzz.test.ts). Lives in src/shared because the
// main-side and renderer-side fuzz suites both consume it and neither
// tsconfig (tsconfig.node.json / tsconfig.tc.web.json) includes the other
// side's sources.
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

/** Builds an @xterm/headless terminal configured exactly like the renderer
 *  pane where buffer state is concerned: scrollback + kitty vtExtensions from
 *  buildDefaultTerminalOptions (pane-terminal-options.ts), Unicode11Addon
 *  (pane-dom-creation.ts) and the Orca ZWJ provider (pane-lifecycle.ts).
 *  Font/cursor/render options are omitted — they never alter buffer cells. */
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

export async function writeChunksToTerminal(terminal: Terminal, chunks: string[]): Promise<void> {
  for (const chunk of chunks) {
    await writeToTerminal(terminal, chunk)
  }
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

/** Known-legitimate serializer normalization: SerializeAddon re-emits palette
 *  indices 0-15 written via 38;5;N / 48;5;N as classic SGR 30-37/90-97, so a
 *  restored cell reports CM_P16 where the live cell reported CM_P256. Both
 *  modes resolve through the same 16 theme slots — no visual difference. */
function canonicalColorMode(mode: number, color: number): number {
  return mode === COLOR_MODE_P256 && color >= 0 && color < 16 ? COLOR_MODE_P16 : mode
}

/** Per-cell descriptor rows so SGR runs that shift cells are caught even
 *  when the text matches. Encodes only VISUALLY EFFECTIVE state:
 *  - glyph cells: char, width, fg, bg, all attribute flags;
 *  - blank cells: width, bg, and fg only when inverse swaps it into the cell
 *    background. Literal spaces retain underline/strikethrough/overline,
 *    while Orca's WebGL glyph renderer skips decorations on null cells.
 *    SerializeAddon may materialize a skipped null run as plain spaces, so
 *    invisible fg/bold/italic state cannot fail the garble gate.
 *  Trailing default blanks are trimmed: the serializer does not re-emit
 *  pristine cells past the last written column. */
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

// Re-exported, never re-spelled: these had drifted from production twice
// (they still carried the pre-#14241 preambles), which left the fuzz and
// colour-parity harnesses asserting against bytes the restorer no longer
// emits — precisely the failure this module's own header warns about (#12101).
// The harnesses replay into a fresh terminal, which starts on the normal
// buffer, so that is the pane state they ground from.
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
  /** Mirror of TerminalSnapshot.pendingEscapeTailAnsi: the trailing
   *  incomplete escape of the hidden byte stream. The restorer writes it
   *  LAST, after its post-replay resets (Bug E fix). */
  pendingEscapeTailAnsi?: string
}

/** Mirror of the production main-buffer snapshot the renderer restore path
 *  consumes: HeadlessEmulator.getSnapshot (snapshotAnsi normalization +
 *  rehydrateSequences + absolute-cursor/DECSC epilogue) composed exactly like
 *  OrcaRuntime.serializeHeadlessTerminalBuffer (normal buffer separated from
 *  an active alt frame). The renderer fuzz cannot import
 *  HeadlessEmulator itself — tsconfig.tc.web.json excludes src/main/daemon. */
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
  // Same composition as HeadlessEmulator.getSnapshot: absolute-cursor CUP for
  // the wrap-pending relative-restore defect plus the DECSC register epilogue.
  let snapshotAnsi = serializeWithAbsoluteCursor(
    parity.serializeAddon,
    terminal,
    { scrollback },
    readSavedCursorRegister(terminal)
  )
  let scrollbackAnsi: string | undefined
  if (alternateScreen) {
    // Why: HeadlessEmulator splits the normal buffer from the active alt frame;
    // rehydrateSequences owns the transition between them.
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
  // Why normal-buffer-only: HeadlessEmulator.getModes reports
  // applicationCursor false while the alternate buffer is active, so the
  // production rehydrate omits ?1h for alt-screen snapshots.
  if (!alternateScreen && terminal.modes.applicationCursorKeysMode) {
    seqs.push('\x1b[?1h')
  }
  // Mouse-mode rehydrate omitted: TerminalMouseModeMirror is main-only and
  // mouse reporting is input encoding — it cannot alter rendered output.
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

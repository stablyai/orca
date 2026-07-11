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
 *  - blank cells (null cells and spaces render identically): width, bg,
 *    underline/strikethrough (drawn across blanks), and fg only when inverse
 *    swaps it into the cell background. SerializeAddon legitimately skips
 *    null cells with cursor motion, dropping their invisible fg/bold/italic
 *    state, and may materialize a skipped run as plain spaces — neither can
 *    be seen, so neither may fail the garble gate.
 *  Trailing default blanks are trimmed: the serializer does not re-emit
 *  pristine cells past the last written column. */
export function visibleRowStyles(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active
  const out: string[] = []
  for (let y = 0; y < terminal.rows; y++) {
    const line = buffer.getLine(buffer.baseY + y)
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
        const blankFlags = [cell.isUnderline(), cell.isStrikethrough()]
          .map((flag) => (flag ? '1' : '0'))
          .join('')
        const inverseFg = cell.isInverse() ? `·if${fgMode}:${cell.getFgColor()}` : ''
        cells.push(
          `▯·w${cell.getWidth()}·b${bgMode}:${cell.getBgColor()}·${blankFlags}${inverseFg}`
        )
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
    const defaultBlank = `▯·w1·b0:-1·00`
    while (cells.length > 0 && cells.at(-1) === defaultBlank) {
      cells.pop()
    }
    out.push(cells.join('|'))
  }
  return out
}

export function cursorPosition(terminal: Terminal): { x: number; y: number } {
  return { x: terminal.buffer.active.cursorX, y: terminal.buffer.active.cursorY }
}

/** KNOWN UPSTREAM BUG predicate (@xterm/addon-serialize 0.15.0-beta.287):
 *  null cells touching a soft-wrap boundary do not round-trip. Two confirmed
 *  variants (see the skipped repros in headless-emulator-fidelity.fuzz.test.ts):
 *  - V1 (cell loss): a wrapped continuation row starting with a NULL cell
 *    (only erasure creates those — typed spaces have chars ' ') passes the
 *    addon's wrap-validity ternary (SerializeAddon.ts ~L214 binds as
 *    `(chars && isDoubleWidth) ? ...`), so the blank is skipped with CUF —
 *    which clamps at the right margin instead of crossing the wrap boundary,
 *    overwriting the previous row's last cell and shifting the tail left.
 *  - V2 (filler artifact): a wrapped pair whose SOURCE row is entirely null
 *    takes the forced-wrap "magic" path, whose cleanup emits `ESC[0C`; CSI
 *    param 0 means 1, so the erase lands one cell right and the first filler
 *    '-' stays visible on the restored screen.
 *  The fuzz suites use this predicate to tolerate (and count) exactly these
 *  divergences without masking unknown ones. */
export function bufferHasSerializeHostileWrappedRow(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active
  for (let y = 1; y < buffer.length; y++) {
    const line = buffer.getLine(y)
    if (!line?.isWrapped) {
      continue
    }
    if (line.getCell(0)?.getChars() === '') {
      return true
    }
    const previous = buffer.getLine(y - 1)
    let previousIsAllNull = previous !== undefined
    for (let x = 0; previous && x < previous.length; x++) {
      if (previous.getCell(x)?.getChars() !== '') {
        previousIsAllNull = false
        break
      }
    }
    if (previousIsAllNull) {
      return true
    }
  }
  return false
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

// Mirror of applyMainBufferSnapshot's clear preamble (pty-connection.ts):
// normal-buffer restores wipe screen+scrollback+home; alt-screen restores
// clear only the alt screen so the normal buffer's scrollback survives.
export const SNAPSHOT_REPLAY_PREAMBLE_NORMAL = '\x1b[2J\x1b[3J\x1b[H'
export const SNAPSHOT_REPLAY_PREAMBLE_ALT = '\x1b[0m\x1b[?1049h\x1b[2J\x1b[H'

// Twin of POST_REPLAY_LIVE_SNAPSHOT_RESET (layout-serialization.ts) — the
// renderer suite pins equality against the real constant so drift fails fast.
export const POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY = '\x1b[0 q\x1b[?25h\x1b[?1004l'

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

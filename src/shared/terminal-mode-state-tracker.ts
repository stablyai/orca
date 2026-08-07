import type { TerminalModes } from './terminal-modes'
import { TerminalMouseModeMirror } from './terminal-mouse-mode-mirror'
import { advancePartialEscapeTail } from './terminal-partial-escape-tail'

/**
 * Tracks the full TerminalModes state a raw byte stream leaves behind:
 * a TerminalMouseModeMirror for mouse protocol/encoding plus a DECSET scanner
 * for alternate screen (47/1047/1049), bracketed paste (2004) and application
 * cursor keys (1). RIS (`ESC c`) resets everything; DECSTR (`CSI ! p`)
 * resets bracketed paste and application cursor without switching buffers,
 * mirroring xterm's CoreService reset.
 *
 * Why kittyKeyboardFlags is always 0: kitty flags are deliberately excluded
 * from replay rehydration — POST_REPLAY_REATTACH_RESET's kitty reset stays
 * authoritative and protocol-conformant programs re-push.
 */
export class TerminalModeStateTracker {
  private readonly mouseModes = new TerminalMouseModeMirror()
  private scanTail = ''
  private bracketedPasteState = false
  private applicationCursorState = false
  private alternateScreenState = false

  seed(modes: TerminalModes): void {
    this.bracketedPasteState = modes.bracketedPaste
    this.applicationCursorState = modes.applicationCursor
    this.alternateScreenState = modes.alternateScreen
    this.mouseModes.scan(buildMouseModeSeedSequences(modes))
  }

  scan(data: string): void {
    this.mouseModes.scan(data)
    // Why the shared fold: PTY/SSH chunks split escape sequences arbitrarily,
    // and the tail must honor real parser semantics — CAN/SUB aborts and
    // OSC/DCS strings — so an aborted or string-embedded fragment can never
    // complete into a mode sequence (same ingest-boundary tracking as
    // headless-emulator.ts). The tail is always a single incomplete sequence,
    // so rescanning it prefixed to the next chunk cannot double-apply a match.
    const input = this.scanTail.length === 0 ? data : this.scanTail + data
    this.scanTail = advancePartialEscapeTail(this.scanTail, data)
    // Why: the tail tracker recognizes only ESC-introduced sequences — a raw C1
    // \x9b introducer split exactly at a chunk boundary is not carried over
    // (complete-in-chunk \x9b sequences still match below).
    // oxlint-disable-next-line no-control-regex -- terminal escape sequences require control chars
    const modeRe = /\x1bc|(?:\x1b\[|\x9b)(?:!p|\?([0-9;]+)([hl]))/g
    let match: RegExpExecArray | null
    while ((match = modeRe.exec(input)) !== null) {
      if (match[0] === '\x1bc') {
        this.bracketedPasteState = false
        this.applicationCursorState = false
        this.alternateScreenState = false
        continue
      }
      if (match[0].endsWith('!p')) {
        // Why: xterm's DECSTR resets DEC private modes (bracketed paste,
        // application cursor) but does not switch buffers.
        this.bracketedPasteState = false
        this.applicationCursorState = false
        continue
      }
      const enabled = match[2] === 'h'
      for (const rawParam of match[1]!.split(';')) {
        if (rawParam === '') {
          continue
        }
        const param = Number(rawParam)
        if (!Number.isInteger(param)) {
          continue
        }
        if (param === 1) {
          this.applicationCursorState = enabled
        }
        if (param === 2004) {
          this.bracketedPasteState = enabled
        }
        if (param === 47 || param === 1047 || param === 1049) {
          this.alternateScreenState = enabled
        }
      }
    }
  }

  getModes(): TerminalModes {
    const mouseTrackingMode = this.mouseModes.mouseTrackingMode
    return {
      bracketedPaste: this.bracketedPasteState,
      mouseTracking: mouseTrackingMode !== 'none',
      mouseTrackingMode,
      sgrMouseMode: this.mouseModes.sgrMouseMode,
      sgrMousePixelsMode: this.mouseModes.sgrMousePixelsMode,
      applicationCursor: this.applicationCursorState,
      alternateScreen: this.alternateScreenState,
      kittyKeyboardFlags: 0
    }
  }
}

/** DECSET stream equivalent of the seed's mouse fields, so the mirror starts from the seeded protocol/encoding state. */
function buildMouseModeSeedSequences(modes: TerminalModes): string {
  const seqs: string[] = []
  switch (modes.mouseTracking ? (modes.mouseTrackingMode ?? 'vt200') : 'none') {
    case 'x10':
      seqs.push('\x1b[?9h')
      break
    case 'vt200':
      seqs.push('\x1b[?1000h')
      break
    case 'drag':
      seqs.push('\x1b[?1002h')
      break
    case 'any':
      seqs.push('\x1b[?1003h')
      break
    case 'none':
      seqs.push('\x1b[?1000l')
      break
  }
  if (modes.sgrMousePixelsMode) {
    seqs.push('\x1b[?1016h')
  } else if (modes.sgrMouseMode) {
    seqs.push('\x1b[?1006h')
  } else {
    seqs.push('\x1b[?1006l\x1b[?1016l')
  }
  return seqs.join('')
}

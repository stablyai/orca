import {
  findOscTerminatorStart,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'
import { MAX_APPEARANCE_OSC_BODY_CHARS } from './terminal-osc-appearance-query'
import {
  parseXColorSpec,
  TERMINAL_VIEW_ANSI_COLOR_COUNT,
  terminalViewRgbToCssHex,
  type TerminalViewRgb
} from './terminal-view-attributes'

// Why a bound: a torn OSC is held across reads, and a runaway one must not grow forever.
const MAX_PENDING_OSC_CHARS = 256

type ColorSlot = 'foreground' | 'background' | 'cursor'

// OSC 10/11/12 stack extra params onto consecutive slots, as xterm does: `OSC 10;fg;bg;cursor`.
const SET_SLOTS: Record<string, readonly ColorSlot[]> = {
  '10': ['foreground', 'background', 'cursor'],
  '11': ['background', 'cursor'],
  '12': ['cursor']
}
const RESET_SLOTS: Record<string, ColorSlot> = {
  '110': 'foreground',
  '111': 'background',
  '112': 'cursor'
}

/** Cheap prefilter so non-colour OSCs (titles, hyperlinks) are never sliced: 10/11 and 110/111, plus 4/104 and
 *  12/112 when the owner answers palette and cursor queries. */
function mayBeColorOsc(input: string, bodyStart: number, appearance: boolean): boolean {
  const next = input[bodyStart + 1]
  if (input[bodyStart] === '4') {
    return appearance && next === ';'
  }
  return input[bodyStart] === '1' && (next === '0' || next === '1' || (appearance && next === '2'))
}

/** Mirror app-set OSC 10/11 and their resets for the PTY owner, and OSC 4/12 for an owner that answers them; theme
 *  changes drop overrides like the viewer does. */
export class TerminalOscColorOverrideTracker {
  private pending = ''
  private overrides: TerminalOscColorQueryReplyColors = {}
  private cursor: TerminalViewRgb | null = null
  private readonly palette = new Map<number, TerminalViewRgb>()
  private overridesBase: string | null = null
  private readonly maxPendingChars: number

  /** `appearance`: also track palette and cursor, holding a torn SET of every palette slot. */
  constructor(private readonly appearance = false) {
    this.maxPendingChars = appearance ? MAX_APPEARANCE_OSC_BODY_CHARS + 16 : MAX_PENDING_OSC_CHARS
  }

  /** `currentBase` is read only when an app sets a colour. */
  scan(data: string, currentBase: () => TerminalOscColorQueryReplyColors): void {
    const input = this.pending + data
    this.pending = ''
    let offset = input.indexOf('\x1b]')
    while (offset !== -1) {
      const bodyStart = offset + 2
      const terminator = findOscTerminatorStart(input, bodyStart)
      const isBel = input[terminator] === '\x07'
      if (terminator === -1 || (!isBel && terminator === input.length - 1)) {
        const tail = input.slice(offset)
        this.pending = tail.length <= this.maxPendingChars ? tail : ''
        return
      }
      if (
        (isBel || input[terminator + 1] === '\\') &&
        mayBeColorOsc(input, bodyStart, this.appearance)
      ) {
        this.apply(input.slice(bodyStart, terminator), currentBase)
      }
      offset = input.indexOf('\x1b]', isBel ? terminator + 1 : terminator)
    }
    if (input.endsWith('\x1b')) {
      this.pending = '\x1b'
    }
  }

  resolve(base: TerminalOscColorQueryReplyColors): TerminalOscColorQueryReplyColors {
    if (this.overridesBase !== null && this.overridesBase !== baseKey(base)) {
      this.overrides = {}
      this.cursor = null
      this.palette.clear()
      this.overridesBase = null
    }
    return { ...base, ...this.overrides }
  }

  /** App-set cursor and palette colours, valid only after `resolve` has seen the current base. */
  resolvedCursor(): TerminalViewRgb | null {
    return this.cursor
  }

  resolvedPaletteColor(index: number): TerminalViewRgb | undefined {
    return this.palette.get(index)
  }

  private apply(body: string, currentBase: () => TerminalOscColorQueryReplyColors): void {
    const [ident = '', ...params] = body.split(';')
    if (ident === '4' || ident === '104') {
      if (this.appearance) {
        this.applyPalette(ident, params, currentBase)
      }
      return
    }
    const reset = RESET_SLOTS[ident]
    if ((reset === 'cursor' || ident === '12') && !this.appearance) {
      return
    }
    if (reset === 'cursor') {
      this.cursor = null
      return
    }
    if (reset) {
      const { foreground, background } = this.overrides
      this.overrides = {
        ...(reset !== 'foreground' && foreground ? { foreground } : {}),
        ...(reset !== 'background' && background ? { background } : {})
      }
      return
    }
    for (const [index, slot] of (SET_SLOTS[ident] ?? []).entries()) {
      const rgb = params[index] === undefined ? null : parseXColorSpec(params[index])
      if (rgb && (slot !== 'cursor' || this.appearance)) {
        this.rebase(currentBase)
        if (slot === 'cursor') {
          this.cursor = rgb
        } else {
          this.overrides = { ...this.overrides, [slot]: terminalViewRgbToCssHex(rgb) }
        }
      }
    }
  }

  private applyPalette(
    ident: string,
    params: string[],
    currentBase: () => TerminalOscColorQueryReplyColors
  ): void {
    if (ident === '104') {
      if (params.length === 0 || (params.length === 1 && params[0] === '')) {
        this.palette.clear()
      }
      for (const param of params) {
        this.palette.delete(Number(param))
      }
      return
    }
    for (let i = 0; i + 1 < params.length; i += 2) {
      const index = /^\d+$/.test(params[i]) ? Number(params[i]) : -1
      const rgb = parseXColorSpec(params[i + 1])
      if (index >= 0 && index < TERMINAL_VIEW_ANSI_COLOR_COUNT && rgb) {
        this.rebase(currentBase)
        this.palette.set(index, rgb)
      }
    }
  }

  /** Drop overrides made against an older theme before recording one against the current theme. */
  private rebase(currentBase: () => TerminalOscColorQueryReplyColors): void {
    const base = currentBase()
    this.resolve(base)
    this.overridesBase = baseKey(base)
  }
}

function baseKey(colors: TerminalOscColorQueryReplyColors): string {
  return `${colors.foreground ?? ''}\n${colors.background ?? ''}`
}

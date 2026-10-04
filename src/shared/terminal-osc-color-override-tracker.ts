import type { TerminalOscColorQueryReplyColors } from './terminal-osc-color-reply'
import { parseXColorSpec, terminalViewRgbToCssHex } from './terminal-view-attributes'

// Why a bound: a torn OSC is held across reads, and a runaway one must not grow forever.
const MAX_PENDING_OSC_CHARS = 256

type ColorSlot = 'foreground' | 'background'

// OSC 10/11 stack extra params onto consecutive slots, as xterm does: `OSC 10;fg;bg`.
const SET_SLOTS: Record<string, readonly ColorSlot[]> = {
  '10': ['foreground', 'background'],
  '11': ['background']
}
const RESET_SLOTS: Record<string, ColorSlot> = { '110': 'foreground', '111': 'background' }

// Why one scan for either terminator: two indexOf calls go quadratic on long runs of
// ST-terminated OSCs with no BEL (OSC 8 hyperlinks), and this runs on every PTY chunk.
// oxlint-disable-next-line no-control-regex -- BEL and ESC are the terminators being matched.
const OSC_TERMINATOR = /[\x07\x1b]/g

/** Cheap prefilter so non-colour OSCs (titles, hyperlinks) are never sliced. */
function mayBeColorOsc(input: string, bodyStart: number): boolean {
  return input[bodyStart] === '1' && (input[bodyStart + 1] === '0' || input[bodyStart + 1] === '1')
}

/**
 * Mirrors what an app set with OSC 10/11 (and cleared with OSC 110/111) on one terminal,
 * so the PTY owner reports the colours the viewer is actually painting. A theme change
 * drops them, as a viewer's own theme apply does.
 */
export class TerminalOscColorOverrideTracker {
  private pending = ''
  private overrides: TerminalOscColorQueryReplyColors = {}
  private overridesBase: string | null = null

  /** `currentBase` is read only when an app sets a colour. */
  scan(data: string, currentBase: () => TerminalOscColorQueryReplyColors): void {
    const input = this.pending + data
    this.pending = ''
    let offset = input.indexOf('\x1b]')
    while (offset !== -1) {
      const bodyStart = offset + 2
      OSC_TERMINATOR.lastIndex = bodyStart
      const terminator = OSC_TERMINATOR.exec(input)?.index ?? -1
      const isBel = input[terminator] === '\x07'
      if (terminator === -1 || (!isBel && terminator === input.length - 1)) {
        const tail = input.slice(offset)
        this.pending = tail.length <= MAX_PENDING_OSC_CHARS ? tail : ''
        return
      }
      if ((isBel || input[terminator + 1] === '\\') && mayBeColorOsc(input, bodyStart)) {
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
      this.overridesBase = null
    }
    return { ...base, ...this.overrides }
  }

  private apply(body: string, currentBase: () => TerminalOscColorQueryReplyColors): void {
    const [ident = '', ...params] = body.split(';')
    const reset = RESET_SLOTS[ident]
    if (reset) {
      const { foreground, background } = this.overrides
      this.overrides = {
        ...(reset !== 'foreground' && foreground ? { foreground } : {}),
        ...(reset !== 'background' && background ? { background } : {})
      }
      return
    }
    const slots = SET_SLOTS[ident]
    if (!slots) {
      return
    }
    for (const [index, slot] of slots.entries()) {
      const rgb = params[index] === undefined ? null : parseXColorSpec(params[index])
      if (rgb) {
        const base = currentBase()
        this.resolve(base)
        this.overrides = { ...this.overrides, [slot]: terminalViewRgbToCssHex(rgb) }
        this.overridesBase = baseKey(base)
      }
    }
  }
}

function baseKey(colors: TerminalOscColorQueryReplyColors): string {
  return `${colors.foreground ?? ''}\n${colors.background ?? ''}`
}

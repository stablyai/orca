import type { IDisposable } from '@xterm/xterm'
import { guardParserHandler } from '@/components/terminal-pane/terminal-parser-handler-guard'

// SerializeAddon omits private DECSET 1006/1016 encoding, so snapshots would make phones send legacy reports to SGR-only TUIs. Mirror parser state for in-band replay.

type TerminalMouseEncoding = 'default' | 'sgr' | 'sgr-pixels'

type PrivateModeParams = (number | number[])[]

export type TerminalMouseEncodingTrackerTarget = {
  parser?: {
    registerCsiHandler?: (
      id: { prefix?: string; final: string },
      handler: (params: PrivateModeParams) => boolean
    ) => IDisposable
    registerEscHandler?: (id: { final: string }, handler: () => boolean) => IDisposable
  }
}

const SGR_MOUSE_MODE = 1006
const SGR_PIXELS_MOUSE_MODE = 1016

const encodingByTerminal = new WeakMap<object, TerminalMouseEncoding>()

// Match xterm mode order; resetting either mode restores default encoding.
function applyPrivateModes(
  terminal: TerminalMouseEncodingTrackerTarget,
  params: PrivateModeParams,
  set: boolean
): boolean {
  let encoding = encodingByTerminal.get(terminal) ?? 'default'
  for (const param of params) {
    if (param === SGR_MOUSE_MODE) {
      encoding = set ? 'sgr' : 'default'
    } else if (param === SGR_PIXELS_MOUSE_MODE) {
      encoding = set ? 'sgr-pixels' : 'default'
    }
  }
  encodingByTerminal.set(terminal, encoding)
  // Why false: this observes the mode change; xterm's own handler still applies it.
  return false
}

/** Mirror the terminal's mouse encoding from every parsed byte, snapshot replays included. */
export function installTerminalMouseEncodingTracker(
  terminal: TerminalMouseEncodingTrackerTarget
): IDisposable {
  encodingByTerminal.set(terminal, 'default')
  const parser = terminal.parser
  const registrations = [
    parser?.registerCsiHandler?.(
      { prefix: '?', final: 'h' },
      guardParserHandler('mouse-encoding-decset', (params: PrivateModeParams) =>
        applyPrivateModes(terminal, params, true)
      )
    ),
    parser?.registerCsiHandler?.(
      { prefix: '?', final: 'l' },
      guardParserHandler('mouse-encoding-decrst', (params: PrivateModeParams) =>
        applyPrivateModes(terminal, params, false)
      )
    ),
    // RIS (ESC c) resets xterm's mouse service to the default encoding.
    parser?.registerEscHandler?.(
      { final: 'c' },
      guardParserHandler('mouse-encoding-ris', () => {
        encodingByTerminal.set(terminal, 'default')
        return false
      })
    )
  ]
  return {
    dispose(): void {
      for (const registration of registrations) {
        registration?.dispose()
      }
      encodingByTerminal.delete(terminal)
    }
  }
}

const RESTORE_ANSI_BY_ENCODING: Record<TerminalMouseEncoding, string> = {
  default: '',
  sgr: `\x1b[?${SGR_MOUSE_MODE}h`,
  'sgr-pixels': `\x1b[?${SGR_PIXELS_MOUSE_MODE}h`
}

/** The DECSET that restores this terminal's mouse encoding on replay. */
export function terminalMouseEncodingRestoreAnsi(terminal: {
  modes?: { mouseTrackingMode?: string }
}): string {
  const encoding = encodingByTerminal.get(terminal) ?? 'default'
  if (encoding === 'default' && (terminal.modes?.mouseTrackingMode ?? 'none') !== 'none') {
    // Why: states the default while tracking, so a replay reader never has to guess it.
    return `\x1b[?${SGR_MOUSE_MODE}l`
  }
  return RESTORE_ANSI_BY_ENCODING[encoding]
}

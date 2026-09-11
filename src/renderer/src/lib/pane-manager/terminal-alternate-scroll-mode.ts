import { guardParserHandler } from '@/components/terminal-pane/terminal-parser-handler-guard'

// DECSET 1007. xterm.js parses no mode here, so Orca tracks it itself.
const ALTERNATE_SCROLL_MODE = 1007
// Alternate-screen modes, in the order terminals have accumulated them.
const ALTERNATE_SCREEN_MODES = [1049, 1047, 47]
const SET_MODE_FINAL = 'h'
const RESET_MODE_FINAL = 'l'
const SOFT_RESET_FINAL = 'p'
const SOFT_RESET_INTERMEDIATE = '!'
const FULL_RESET_FINAL = 'c'

// Why split: xterm only accepts a prefix in 0x3c..0x3f, so DECSTR's `!` is an
// intermediate byte, not a prefix.
type CsiHandlerId = { prefix?: string; intermediates?: string; final: string }
type ParserHandler = (params: (number | number[])[]) => boolean

export type TerminalAlternateScrollModeTarget = {
  parser?: {
    registerCsiHandler?: (id: CsiHandlerId, handler: ParserHandler) => { dispose: () => void }
    registerEscHandler?: (id: { final: string }, handler: () => boolean) => { dispose: () => void }
  }
}

export type TerminalAlternateScrollMode = {
  /** The app's explicit DECSET 1007 state, or undefined while it has never set it. */
  appPreference: () => boolean | undefined
  dispose: () => void
}

function paramsIncludeMode(params: (number | number[])[], modes: number[]): boolean {
  return params.some((param) =>
    Array.isArray(param) ? param.some((value) => modes.includes(value)) : modes.includes(param)
  )
}

/**
 * Tracks DECSET 1007 (alternate scroll mode) so wheel routing can tell an app
 * that wants wheel-as-cursor-keys from one that has turned it off.
 *
 * Why tracked here: xterm.js implements neither the mode nor a way to read it,
 * and synthesizes cursor keys purely from "the buffer has no scrollback".
 */
export function attachTerminalAlternateScrollModeTracking(
  terminal: TerminalAlternateScrollModeTarget
): TerminalAlternateScrollMode {
  let appPreference: boolean | undefined

  // Why scoped to one alternate-screen session: the mode only steers the wheel
  // on the alternate screen, and a preference left behind by an app that has
  // already exited would silently retune the wheel for whatever the user runs
  // in the pane next. Entering and leaving the alternate screen both clear it,
  // so each fullscreen app starts from the user's setting.
  const observeSetPrivateMode = (params: (number | number[])[]) => {
    if (paramsIncludeMode(params, ALTERNATE_SCREEN_MODES)) {
      appPreference = undefined
    }
    if (paramsIncludeMode(params, [ALTERNATE_SCROLL_MODE])) {
      appPreference = true
    }
    // Why false: this observes the mode, it does not implement the sequence.
    return false
  }

  const observeResetPrivateMode = (params: (number | number[])[]) => {
    if (paramsIncludeMode(params, [ALTERNATE_SCROLL_MODE])) {
      appPreference = false
    }
    if (paramsIncludeMode(params, ALTERNATE_SCREEN_MODES)) {
      appPreference = undefined
    }
    return false
  }

  // Why cleared on reset too: a killed TUI or a dropped SSH session can leave
  // the pane on the alternate screen with no exit sequence ever arriving.
  const observeReset = () => {
    appPreference = undefined
    return false
  }

  const registrations = [
    terminal.parser?.registerCsiHandler?.(
      { prefix: '?', final: SET_MODE_FINAL },
      guardParserHandler('csi-alternate-scroll-set', observeSetPrivateMode)
    ),
    terminal.parser?.registerCsiHandler?.(
      { prefix: '?', final: RESET_MODE_FINAL },
      guardParserHandler('csi-alternate-scroll-reset', observeResetPrivateMode)
    ),
    terminal.parser?.registerCsiHandler?.(
      { intermediates: SOFT_RESET_INTERMEDIATE, final: SOFT_RESET_FINAL },
      guardParserHandler('csi-alternate-scroll-soft-reset', observeReset)
    ),
    terminal.parser?.registerEscHandler?.(
      { final: FULL_RESET_FINAL },
      guardParserHandler('esc-alternate-scroll-full-reset', observeReset)
    )
  ]

  return {
    appPreference: () => appPreference,
    dispose: () => {
      for (const registration of registrations) {
        registration?.dispose()
      }
    }
  }
}

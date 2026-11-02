import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'
import { resolveConfiguredTerminalColors } from './terminal-theme-selection'

// Last resort before this process is told anything: Orca's default dark terminal theme.
export const ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS: TerminalOscColorQueryReplyColors =
  resolveConfiguredTerminalColors(
    {
      theme: 'dark',
      terminalThemeDark: '',
      terminalUseSeparateLightTheme: false,
      terminalThemeLight: ''
    },
    true
  )

function answersBothSlots(
  colors: TerminalOscColorQueryReplyColors | null | undefined
): colors is TerminalOscColorQueryReplyColors {
  return !!colors && terminalOscColorQueryReplies(colors, [10, 11]) !== null
}

/** Wire payloads are untrusted; only a pair that can answer both OSC 10 and 11 is kept. */
export function normalizeColorQueryReplyColors(
  value: unknown
): TerminalOscColorQueryReplyColors | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const foreground = 'foreground' in value ? value.foreground : undefined
  const background = 'background' in value ? value.background : undefined
  if (typeof foreground !== 'string' || typeof background !== 'string') {
    return null
  }
  const colors = { foreground, background }
  return answersBothSlots(colors) ? colors : null
}

export function colorQueryReplyColorsEqual(
  a: TerminalOscColorQueryReplyColors | null,
  b: TerminalOscColorQueryReplyColors | null
): boolean {
  return a?.foreground === b?.foreground && a?.background === b?.background
}

// Each PTY-owning process serves one host; its viewer pushes one host-wide theme for all panes.
let hostColors: TerminalOscColorQueryReplyColors | null = null

/** A malformed push keeps the previous colours rather than blanking them. */
export function setPtyOwnerHostColors(value: unknown): void {
  hostColors = normalizeColorQueryReplyColors(value) ?? hostColors
}

export function getPtyOwnerHostColors(): TerminalOscColorQueryReplyColors | null {
  return hostColors
}

export function _resetPtyOwnerHostColorsForTest(): void {
  hostColors = null
}

/** A launching client's theme pins its PTY; otherwise the host-wide viewer theme overrides spawn colors so old panes
 * track theme changes; use the default before any viewer reports. */
export function resolvePtyOwnerColorQueryColors(
  host: TerminalOscColorQueryReplyColors | null | undefined,
  spawn: TerminalOscColorQueryReplyColors | null | undefined,
  launcher?: TerminalOscColorQueryReplyColors | null
): TerminalOscColorQueryReplyColors {
  return [launcher, host, spawn].find(answersBothSlots) ?? ORCA_DEFAULT_COLOR_QUERY_REPLY_COLORS
}

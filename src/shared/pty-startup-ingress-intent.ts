import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'
import { normalizeColorQueryReplyColors } from './pty-owner-color-query-colors'
import {
  validateTerminalViewAttributes,
  type TerminalViewAttributes
} from './terminal-view-attributes'

export type PtyStartupIngressIntent = {
  colors: TerminalOscColorQueryReplyColors
  /** The theme of the remote client that launched this PTY. Its owner then answers every theme query with it,
   *  over the host-wide theme; older owners drop it. */
  launcherColors?: TerminalOscColorQueryReplyColors
  /** That client's palette and cursor for OSC 4/12; absent from older clients, which leaves those queries silent. */
  launcherAttributes?: TerminalViewAttributes
  kittyKeyboardProtocol?: boolean
  deadlineMs: number
}

export const PTY_STARTUP_INGRESS_VERSION = 2

export function parsePtyStartupIngressIntent(value: unknown): PtyStartupIngressIntent | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const kittyKeyboardProtocol =
    'kittyKeyboardProtocol' in value && value.kittyKeyboardProtocol === true
  const colors = 'colors' in value ? value.colors : undefined
  const normalizedColors = {
    ...(colors &&
    typeof colors === 'object' &&
    'foreground' in colors &&
    typeof colors.foreground === 'string'
      ? { foreground: colors.foreground }
      : {}),
    ...(colors &&
    typeof colors === 'object' &&
    'background' in colors &&
    typeof colors.background === 'string'
      ? { background: colors.background }
      : {})
  }
  const launcherColors = normalizeColorQueryReplyColors(
    'launcherColors' in value ? value.launcherColors : undefined
  )
  const launcherAttributes = launcherColors
    ? validateTerminalViewAttributes(
        'launcherAttributes' in value ? value.launcherAttributes : undefined
      )
    : null
  const deadlineMs = 'deadlineMs' in value ? value.deadlineMs : undefined
  if (
    (!kittyKeyboardProtocol && !terminalOscColorQueryReplies(normalizedColors, [10, 11])) ||
    typeof deadlineMs !== 'number' ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs < 0 ||
    deadlineMs > 30_000
  ) {
    return undefined
  }
  return {
    colors: normalizedColors,
    ...(launcherColors ? { launcherColors } : {}),
    ...(launcherAttributes ? { launcherAttributes } : {}),
    ...(kittyKeyboardProtocol ? { kittyKeyboardProtocol: true } : {}),
    deadlineMs
  }
}

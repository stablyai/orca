import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'

export type PtyStartupIngressIntent = {
  colors: TerminalOscColorQueryReplyColors
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
    ...(kittyKeyboardProtocol ? { kittyKeyboardProtocol: true } : {}),
    deadlineMs
  }
}

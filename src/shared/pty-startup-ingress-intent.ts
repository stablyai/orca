import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'

export type PtyStartupIngressIntent = {
  colors?: TerminalOscColorQueryReplyColors
  kittyKeyboardAdvertised?: true
  deadlineMs: number
}

export const PTY_STARTUP_INGRESS_VERSION = 2

export function parsePtyStartupIngressIntent(value: unknown): PtyStartupIngressIntent | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const colors = record.colors
  const colorRecord =
    colors && typeof colors === 'object' ? (colors as Record<string, unknown>) : {}
  const normalizedColors = {
    ...(typeof colorRecord.foreground === 'string' ? { foreground: colorRecord.foreground } : {}),
    ...(typeof colorRecord.background === 'string' ? { background: colorRecord.background } : {})
  }
  const validColors = terminalOscColorQueryReplies(normalizedColors, [10, 11])
  const kittyKeyboardAdvertised = record.kittyKeyboardAdvertised === true
  if (
    (!validColors && !kittyKeyboardAdvertised) ||
    typeof record.deadlineMs !== 'number' ||
    !Number.isFinite(record.deadlineMs) ||
    record.deadlineMs < 0 ||
    record.deadlineMs > 30_000
  ) {
    return undefined
  }
  return {
    ...(validColors ? { colors: normalizedColors } : {}),
    ...(kittyKeyboardAdvertised ? { kittyKeyboardAdvertised: true as const } : {}),
    deadlineMs: record.deadlineMs
  }
}

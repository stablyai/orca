import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'

export type PtyStartupIngressIntent = {
  colors: TerminalOscColorQueryReplyColors
  deadlineMs: number
  echoProjection?: 'windows-conpty-esc-stripped'
}

export const PTY_STARTUP_INGRESS_VERSION = 1

export function parsePtyStartupIngressIntent(
  value: unknown,
  options: { allowWindowsEchoProjection: boolean }
): PtyStartupIngressIntent | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const record = value as Record<string, unknown>
  const colors = record.colors
  if (!colors || typeof colors !== 'object') {
    return undefined
  }
  const colorRecord = colors as Record<string, unknown>
  const normalizedColors = {
    ...(typeof colorRecord.foreground === 'string' ? { foreground: colorRecord.foreground } : {}),
    ...(typeof colorRecord.background === 'string' ? { background: colorRecord.background } : {})
  }
  if (
    !terminalOscColorQueryReplies(normalizedColors, [10, 11]) ||
    typeof record.deadlineMs !== 'number' ||
    !Number.isFinite(record.deadlineMs) ||
    record.deadlineMs < 0 ||
    record.deadlineMs > 30_000
  ) {
    return undefined
  }
  const projection = record.echoProjection
  if (
    projection !== undefined &&
    (projection !== 'windows-conpty-esc-stripped' || !options.allowWindowsEchoProjection)
  ) {
    return undefined
  }
  return {
    colors: normalizedColors,
    deadlineMs: record.deadlineMs,
    ...(projection === 'windows-conpty-esc-stripped' ? { echoProjection: projection } : {})
  }
}

export const TERMINAL_LIMIT_RUNTIME_CAPABILITY = 'terminal.limit-policy.v1' as const
export const MAX_CONFIGURED_TERMINALS = 4096

export type TerminalLimitStatus = {
  maxTerminals: number
  systemPtyLimit: number | null
  source: 'environment' | 'saved' | 'default'
  savedUnreadable?: boolean
  editable: boolean
  daemonNonce: string
}

export type TerminalLimitUpdate = { maxTerminals: number; daemonNonce: string }

export function isConfiguredTerminalLimit(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CONFIGURED_TERMINALS
  )
}

export function terminalLimitInputMaximum(systemPtyLimit: number | null): number {
  return Math.min(MAX_CONFIGURED_TERMINALS, systemPtyLimit ?? MAX_CONFIGURED_TERMINALS)
}

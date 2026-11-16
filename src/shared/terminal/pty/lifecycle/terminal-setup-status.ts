export type TerminalSetupVerdict = {
  dependencyId: string | null
  state: 'pending' | 'ready' | 'failed' | 'unknown'
}

export type TerminalSetupStatus = TerminalSetupVerdict & {
  runtimeId: string
  ptyId: string
}

export function isTerminalSetupStatus(value: unknown): value is TerminalSetupStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    'runtimeId' in value &&
    typeof value.runtimeId === 'string' &&
    'ptyId' in value &&
    typeof value.ptyId === 'string' &&
    'dependencyId' in value &&
    (value.dependencyId === null || typeof value.dependencyId === 'string') &&
    'state' in value &&
    ['pending', 'ready', 'failed', 'unknown'].includes(String(value.state))
  )
}

export type TerminalStreamEndVerdict = 'exited' | 'unverifiable'

export function parseTerminalStreamEndVerdict(value: unknown): TerminalStreamEndVerdict {
  return value === 'exited' ? 'exited' : 'unverifiable'
}

/** Numeric exit status riding on a multiplex `end` event, or null when absent. */
export function parseTerminalStreamEndExitCode(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

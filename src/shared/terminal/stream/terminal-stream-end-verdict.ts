export type TerminalStreamEndVerdict = 'exited' | 'unverifiable'

export function parseTerminalStreamEndVerdict(value: unknown): TerminalStreamEndVerdict {
  return value === 'exited' ? 'exited' : 'unverifiable'
}

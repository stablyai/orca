export type TerminalOwner = 'shell'

export function parseTerminalOwner(value: unknown): TerminalOwner | undefined {
  return value === 'shell' ? value : undefined
}

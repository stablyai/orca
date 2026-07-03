export type TerminalOscLinkRange = {
  row: number
  startCol: number
  endCol: number
  uri: string
}

export function isTerminalOscLinkRanges(value: unknown): value is TerminalOscLinkRange[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        entry != null &&
        typeof entry === 'object' &&
        Number.isInteger((entry as TerminalOscLinkRange).row) &&
        Number.isInteger((entry as TerminalOscLinkRange).startCol) &&
        Number.isInteger((entry as TerminalOscLinkRange).endCol) &&
        typeof (entry as TerminalOscLinkRange).uri === 'string'
    )
  )
}

import type { RuntimeTerminalState } from './runtime-terminal-contracts'

/** `terminal.read` flattened for agent consumption: the retained tail as one ANSI-free string. */
export type RuntimeTerminalHistory = {
  handle: string
  status: RuntimeTerminalState
  history: string
  lineCount: number
  /** Older output was dropped by the retention or tail cap; this is not the whole session. */
  truncated: boolean
  source?: 'stream' | 'screen' | 'screen-unavailable'
}

import type { TuiAgent } from './tui-agent'
export type { TuiAgent } from './tui-agent'

// Why: recognizing a manually started agent must not register an Orca launcher.
export type TerminalAgent = TuiAgent | 'dsb'

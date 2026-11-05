import type { TuiAgent } from '../../agent-launch/catalog/tui-agent'

// Why: recognizing a manually started agent must not register an Orca launcher.
export type TerminalAgent = TuiAgent | 'dsb'

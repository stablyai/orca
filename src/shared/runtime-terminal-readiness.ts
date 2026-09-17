import type { TuiAgent } from './tui-agent'

export type RuntimeTerminalReadiness = {
  state: 'ready' | 'blocked' | 'busy' | 'unsupported' | 'unknown'
  source: 'title' | 'screen' | 'first-party' | 'capability' | 'none'
  agent?: TuiAgent
}

import type { TuiAgent } from './tui-agent'

export type GeneratedAgentInputNotice = {
  id: string
  agent: TuiAgent
  text: string
  handle: string
  worktreeId: string
  ptyId: string | null
  certainty: 'not-sent' | 'unconfirmed'
}

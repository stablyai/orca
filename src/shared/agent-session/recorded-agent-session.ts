import type { TuiAgent } from '../agent-launch/catalog/tui-agent'
import type { AgentProviderSessionMetadata } from './lifecycle/agent-session-resume'

export type RecordedAgentSessionIdentity = {
  agent: TuiAgent
  providerSession: AgentProviderSessionMetadata
}

export type RecordedAgentSession = RecordedAgentSessionIdentity & {
  worktreeId: string
  paneKey: string
  connected: boolean
}

export type RecordedAgentSessionTarget =
  | { paneKey: string; agent?: TuiAgent; sessionId?: string }
  | { paneKey?: string; agent: TuiAgent; sessionId: string }

export type RecordedAgentSessionResume = RecordedAgentSessionIdentity & {
  worktreeId: string
  paneKey: string
  handle: string
  ptyId: string
  disposition: 'resumed' | 'adopted'
}

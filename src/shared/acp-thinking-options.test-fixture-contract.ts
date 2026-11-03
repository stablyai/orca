import type { AgentSessionOptionsResult } from './agent-session/options/agent-session-options-result'

export type AcpThinkingOptionsFixtureModule = {
  recordedOmpOptions: (
    origin: 'new' | 'loaded',
    count?: number
  ) => {
    read: () => Pick<AgentSessionOptionsResult, 'models' | 'current'>
  }
}

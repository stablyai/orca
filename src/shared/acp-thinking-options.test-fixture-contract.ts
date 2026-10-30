import type { AgentSessionOptionsResult } from './agent-session-wire'

export type AcpThinkingOptionsFixtureModule = {
  recordedOmpOptions: (
    origin: 'new' | 'loaded',
    count?: number
  ) => {
    read: () => Pick<AgentSessionOptionsResult, 'models' | 'current'>
  }
}

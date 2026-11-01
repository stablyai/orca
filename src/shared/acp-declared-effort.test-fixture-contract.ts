import type { AgentSessionModelCatalogResult } from './agent-session/agent-session-wire'
import type { AgentSessionOptionsResult } from './agent-session/options/agent-session-options-result'

export type DeclaredEffortCase = 'low' | 'max' | 'opencode' | 'absent'
export type AcpDeclaredEffortFixtureModule = {
  recordedEffortCase: (input: DeclaredEffortCase) => Promise<{
    agent: string
    model: string
    policy: string
    display: string | null | undefined
    catalog: AgentSessionModelCatalogResult
    live: AgentSessionOptionsResult
    resting: AgentSessionOptionsResult
    launch: AgentSessionOptionsResult
  }>
}

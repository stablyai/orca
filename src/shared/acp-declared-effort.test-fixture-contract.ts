import type {
  AgentSessionModelCatalogResult,
  AgentSessionOptionsResult
} from './agent-session-wire'

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

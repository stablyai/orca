import type { AgentStatusCacheIdentity, RefusedPaneResume } from './agent-status-ipc-payload'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig,
  SleepingAgentSessionRecord
} from './agent-session-resume'
import type { TuiAgent } from './tui-agent'

/** A host home check for this exact saved continuation, not a terminal writer claim. */
export type SavedResumeDecision = {
  agent: string
  providerSession: AgentProviderSessionMetadata
  verdict: 'admitted' | 'chat-home' | 'chat-writing' | 'unverifiable'
}

/** Effective facts of a terminal launch; a refused shell carries no rejected agent metadata. */
export type TerminalLaunchResult = {
  savedResumeDecision?: SavedResumeDecision
  agentResumeUnavailable?: true
  agentResumeRefused?: 'chat-home' | 'chat-writing' | 'unverifiable'
  refusedResume?: RefusedPaneResume
  launchConfig?: SleepingAgentLaunchConfig
  launchAgent?: TuiAgent
  launchToken?: string
  resumeProviderSession?: AgentProviderSessionMetadata
}

/** Runtime-only source shared by copies of one saved startup. Never persisted or sent to a host. */
export type SavedResumeStartupSource = {
  cancelled: boolean
  record?: SleepingAgentSessionRecord
  expectedStatus?: AgentStatusCacheIdentity
}

/** Forward only effective launch facts through each existing terminal envelope. */
export function terminalLaunchFacts(result: TerminalLaunchResult): TerminalLaunchResult {
  return {
    ...(result.savedResumeDecision ? { savedResumeDecision: result.savedResumeDecision } : {}),
    ...(result.agentResumeUnavailable
      ? { agentResumeUnavailable: result.agentResumeUnavailable }
      : {}),
    ...(result.agentResumeRefused ? { agentResumeRefused: result.agentResumeRefused } : {}),
    ...(result.refusedResume ? { refusedResume: result.refusedResume } : {}),
    ...(result.launchConfig ? { launchConfig: result.launchConfig } : {}),
    ...(result.launchAgent ? { launchAgent: result.launchAgent } : {}),
    ...(result.launchToken ? { launchToken: result.launchToken } : {}),
    ...(result.resumeProviderSession ? { resumeProviderSession: result.resumeProviderSession } : {})
  }
}

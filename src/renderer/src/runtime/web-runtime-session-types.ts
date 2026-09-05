import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery
} from '../../../shared/agent-session-host-authority'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/tui-agent'

export type WebRuntimeTerminalCreateOutcome =
  | { status: 'created' }
  | { status: 'failed'; message: string }

export type CreateWebRuntimeSessionTerminalArgs = {
  worktreeId: string
  environmentId?: string | null
  afterTabId?: string
  targetGroupId?: string
  command?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: StartupCommandDelivery
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  agent?: TuiAgent
  launchAgent?: TuiAgent
  agentSessionKind?: 'fresh' | 'resume'
  prompt?: string
  promptDelivery?: AgentPromptDelivery
  /** Explicit CLI override; omission leaves the remote host's defaults authoritative. */
  agentArgs?: string | null
  launchPreferences?: AgentLaunchPreferences
  providerSession?: AgentProviderSessionMetadata
  viewMode?: 'terminal' | 'chat'
  activate?: boolean
  selectWorktree?: boolean
}

export type CreatedWebRuntimeSessionTerminal = {
  outcome: WebRuntimeTerminalCreateOutcome
  hostTabId?: string
}

export type CreatedAgentTerminalIdentity = Pick<RuntimeTerminalCreate, 'tabId' | 'paneKey'> & {
  leafId?: string
}

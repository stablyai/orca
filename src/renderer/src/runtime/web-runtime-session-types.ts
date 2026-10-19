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
  /** The Windows shell the terminal runs as, never typed into the host default shell. */
  shell?: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  startupCommandDelivery?: StartupCommandDelivery
  launchConfig?: SleepingAgentLaunchConfig
  launchToken?: string
  agent?: TuiAgent
  launchAgent?: TuiAgent
  /** The command already encodes the complete agent startup and prompt-delivery plan. */
  preparedAgentCommand?: boolean
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
  /** A live session existed and the create was not confirmed, as opposed to no session to ask. */
  hostFailed?: true
}

export type CreatedAgentTerminalIdentity = Pick<RuntimeTerminalCreate, 'tabId' | 'paneKey'> & {
  leafId?: string
}

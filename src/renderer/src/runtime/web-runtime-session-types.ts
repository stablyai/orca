import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type {
  AgentLaunchPreferences,
  AgentPromptDelivery
} from '../../../shared/agent-session/agent-session-host-authority'
import type { StartupCommandDelivery } from '../../../shared/agent-launch/startup/codex-startup-delivery'
import type { RuntimeTerminalCreate } from '../../../shared/runtime-types'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'
import type { RuntimeCapability } from '../../../shared/protocol-version'

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
  trustWorktreeId?: string
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
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  extraAgentArgs?: string
  agentSessionCreateCapability?: RuntimeCapability
  /** Foreground fresh launches select their compatibility recipe only after negotiation. */
  legacyAgentLaunch?: () => Promise<
    Pick<
      CreateWebRuntimeSessionTerminalArgs,
      'command' | 'env' | 'launchConfig' | 'startupCommandDelivery'
    > & { agentPrompt?: string }
  >
  providerSession?: AgentProviderSessionMetadata
  viewMode?: 'terminal' | 'chat'
  activate?: boolean
  selectWorktree?: boolean
}

export type CreateWebRuntimeSessionTerminalOnHostArgs = CreateWebRuntimeSessionTerminalArgs & {
  environmentId: string | null
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

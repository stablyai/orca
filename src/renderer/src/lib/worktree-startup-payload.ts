import type { AgentStartupPlan } from '../../../shared/agent-launch/startup/tui-agent-startup'
import type { TuiAgent } from '../../../shared/agent-launch/catalog/tui-agent'
import type { EventProps } from '../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../shared/agent-launch/startup/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session/lifecycle/agent-session-resume'
import type { SessionOptionValue } from '../../../shared/native-chat/input/native-chat-session-options'

/** Telemetry threaded from the launch site to `pty:spawn`; main fires `agent_started`
 *  only after the spawn succeeds. See telemetry-plan.md§Agent launch semantics. */
export type AgentStartedTelemetry = EventProps<'agent_started'>

export type FreshWorkspaceAgentLaunch = {
  agentArgs?: string | null
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  prompt: string
  promptDelivery: 'draft' | 'auto-submit' | 'submit-after-ready'
  /** Recovery owns delivery; ordinary pane seeds retain their existing completion owner. */
  recovery?: true
  legacy?: () => AgentStartupPlan | null
}

/** Startup command threaded onto a worktree's first terminal at activation. */
export type WorktreeStartupPayload = {
  command: string
  freshAgentLaunch?: FreshWorkspaceAgentLaunch
  env?: Record<string, string>
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  launchToken?: string
  launchAgent?: TuiAgent
  draftPrompt?: string
  startupCommandDelivery?: StartupCommandDelivery
  initialAgentStatus?: { agent: TuiAgent; prompt: string }
  sessionOptions?: Record<string, SessionOptionValue>
  telemetry?: AgentStartedTelemetry
}

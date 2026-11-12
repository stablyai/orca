import type { TerminalOptionEdits } from '../../../../../shared/agent-launch/choices/agent-launch-choices'
import type { LaunchAgentStartupPromptPlan } from '@/lib/agent-session/launch/prompt/launch-agent-startup-prompt-plan'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import type { EventProps } from '../../../../../shared/telemetry-event-classification'
import type { StartupCommandDelivery } from '../../../../../shared/agent-launch/startup/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { SessionOptionValue } from '../../../../../shared/native-chat/input/native-chat-session-options'

/** Telemetry threaded from the launch site to `pty:spawn`; main fires `agent_started`
 *  only after the spawn succeeds. See telemetry-plan.md§Agent launch semantics. */
export type AgentStartedTelemetry = EventProps<'agent_started'>

export type FreshWorkspaceAgentLaunch = {
  agentArgs?: string | null
  terminalOptionEdits?: TerminalOptionEdits
  actionAgentArgs?: string
  sessionOptions?: Readonly<Record<string, SessionOptionValue>>
  prompt: string
  promptDelivery: 'draft' | 'auto-submit' | 'submit-after-ready'
  /** Recovery may replace the compatibility command; all hosted fresh launches own text delivery. */
  recovery?: true
  legacy?: () => LaunchAgentStartupPromptPlan
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

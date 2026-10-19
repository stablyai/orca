import type { TuiAgent } from '../../../shared/tui-agent'
import type { EventProps } from '../../../shared/telemetry-events'
import type { StartupCommandDelivery } from '../../../shared/codex-startup-delivery'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../shared/agent-session-resume'
import type { SessionOptionValue } from '../../../shared/native-chat-session-options'

/** Telemetry threaded from the launch site to `pty:spawn`; main fires `agent_started`
 *  only after the spawn succeeds. See telemetry-plan.md§Agent launch semantics. */
export type AgentStartedTelemetry = EventProps<'agent_started'>

/** Startup command threaded onto a worktree's first terminal at activation. */
export type WorktreeStartupPayload = {
  command: string
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

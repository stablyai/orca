import type { FreshWorkspaceAgentLaunch } from '@/lib/workspace/creation/worktree-startup-payload'
import type { EventProps } from '../../../../../../shared/telemetry-event-classification'
import type { StartupCommandDelivery } from '../../../../../../shared/agent-launch/startup/codex-startup-delivery'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type {
  AgentProviderSessionMetadata,
  SleepingAgentLaunchConfig
} from '../../../../../../shared/agent-session/lifecycle/agent-session-resume'
import type { SavedResumeStartupSource } from '../../../../../../shared/agent-session/lifecycle/saved-resume-startup-source'
import type { SessionOptionValue } from '../../../../../../shared/native-chat/input/native-chat-session-options'
import type { AgentPaneLaunchRequest } from '../../../../../../shared/agent-launch/contracts/agent-pane-launch-request'

export type PtyPaneStartup = {
  /** Absent when the startup carries only spawn env, e.g. a paired viewer's plain terminal (#39852). */
  command?: string
  /** Renderer-delivered startup input for callers that need xterm paste
   *  semantics before the submit Enter. */
  delivery?: 'terminal-paste'
  startupCommandDelivery?: StartupCommandDelivery
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  resumeProviderSession?: AgentProviderSessionMetadata
  /** `saved`: a resume built from saved facts, which the host refuses for a chat's conversation. */
  resumeOrigin?: 'saved'
  resumeSource?: SavedResumeStartupSource
  launchToken?: string
  launchAgent?: TuiAgent
  /** The agent launch the pane's own spawn starts, instead of `command`. */
  agentLaunch?: AgentPaneLaunchRequest
  freshAgentLaunch?: FreshWorkspaceAgentLaunch
  /** Explicit CLI override for host-owned agent launches; omission uses host settings. */
  agentArgsOverride?: string | null
  draftPrompt?: string
  sessionOptions?: Record<string, SessionOptionValue>
  /** Main emits agent_started only after successful spawn. */
  telemetry?: EventProps<'agent_started'>
  /** Initial prompt-start status for agents that lack native prompt hooks. */
  initialAgentStatus?: { agent: TuiAgent; prompt: string }
  /** Show the restored-session banner when this startup command mounts. */
  showSessionRestoredBanner?: boolean
} | null

import type { AgentStartupPlan } from '@/lib/tui-agent-startup'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { LaunchSource } from '../../../shared/telemetry-events'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'

export type LaunchAgentInNewTabArgs = {
  agent: TuiAgent
  worktreeId: string
  /** The host the caller picked from a surface listing one row per host. `worktreeId` names
   *  no host, so without this two publications of it resolve to whichever comes first. */
  executionHostId?: ExecutionHostId
  /** Tab group the user launched from; keeps split-group launches in that pane instead of the active group. */
  groupId?: string
  /** Optional initial prompt; delivery depends on `promptDelivery` and the agent's prompt mode. */
  prompt?: string
  /** Optional CLI arguments appended to the selected agent command. */
  agentArgs?: string | null
  initialCwd?: string | null
  /** How to deliver the prompt: `draft` leaves it editable, `submit-after-ready` sends it once the TUI is ready. */
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  /** Telemetry surface that initiated this launch. Defaults to the tab-bar quick-launch entry point. */
  launchSource?: LaunchSource
  /** User-authored Quick Command label for local tabs created from the tab bar. */
  quickCommandLabel?: string | null
  /** Shell platform for the startup command; defaults to renderer OS. SSH/WSL worktrees run Linux even from Windows. */
  launchPlatform?: NodeJS.Platform
  /** Called after the prompt is actually delivered to the agent input path. */
  onPromptDelivered?: () => void
  /** Whether the new tab takes the foreground. Default true, as the tab bar's `+` expects.
   *  A caller launching into a workspace it is not standing in — the session grid — passes
   *  false: `createTab` otherwise moves the GLOBAL `activeTabId`, and the terminal view
   *  would replace whatever surface the ACTIVE workspace was showing. */
  activate?: boolean
  /** Keeps a preflighted route authoritative across workspace creation. */
  agentSessionLaunchPlan?: AgentSessionLaunchPlan
  /** Lets a workspace reveal itself before the selected surface opens. */
  beforeSurfaceOpen?: (
    surface:
      | { kind: 'local-terminal' }
      | { kind: 'local-agent-session'; sessionId: string }
      | { kind: 'host-published' }
  ) => boolean | void
}

export type AgentLaunchSurface =
  | { kind: 'local-terminal'; tabId: string }
  | { kind: 'local-agent-session'; tabId: string; sessionId: string }
  | { kind: 'host-published' }

export type LaunchAgentInNewTabResult = {
  surface: AgentLaunchSurface
  startupPlan: AgentStartupPlan
  pasteDraftAfterLaunch: boolean
  promptDeliveryResult?: Promise<{ delivered: boolean; failureNotified: boolean }>
  /** Structured route only: what the launch did once it settled. The call stays synchronous. */
  structuredSettlement?: Promise<StructuredAgentLaunchSettlement>
} | null

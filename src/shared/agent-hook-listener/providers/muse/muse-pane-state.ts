import type { AgentMainAgentStatus } from '../../../agent-status/lifecycle/main-agent-status'
import type { MuseSessionLogState } from './muse-session-log'

export type MusePaneState = {
  /** Internal reminder/subagent sessions; their hooks inherit the pane env and fire even after Stop. */
  childSessionIds: Set<string>
  /** Spawned subagents between SubagentStart and SubagentStop, by child session id, with their last hook time. */
  runningChildren: Map<string, number>
  /** Main-agent status as last derived, so restatements keep its clock. */
  mainAgent?: AgentMainAgentStatus
  log?: MuseSessionLogState
  /** Muse emits PermissionRequest for auto-approved calls too; only Notification confirms a visible prompt. */
  pendingApproval?: { toolName?: string; toolInput?: unknown }
}

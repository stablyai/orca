import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import { foldAgentLeadStatus, type AgentLeadStatusResolution } from './agent-lead-status-fold'
import { agentChildWorkLiveness } from './agent-status-child-work-liveness'
import type { AgentStatusState, AgentSubagentSnapshot } from './agent-status-types'

type RowChildWork = Pick<AgentHookEventPayload, 'claudeRunningNonAgentTask'> & {
  payload: { subagents?: readonly AgentSubagentSnapshot[] }
}

/** Remote provider records stay on the relay; desktops can fold only the roster and shell/cron evidence carried by the row. */
export function foldMainAgentWithRowChildWork(
  leadState: AgentStatusState,
  row: RowChildWork
): AgentLeadStatusResolution {
  const childWorkLiveness = agentChildWorkLiveness([
    ...(row.payload.subagents?.map((child) => ({ kind: 'agent' as const, state: child.state })) ??
      []),
    ...(row.claudeRunningNonAgentTask
      ? [{ kind: 'command' as const, state: 'working' as const }]
      : [])
  ])
  return foldAgentLeadStatus({ leadState, childWorkLiveness })
}

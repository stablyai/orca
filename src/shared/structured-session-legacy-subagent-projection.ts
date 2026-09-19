// The renderer bridge's wire-to-sidebar child projection, lifted out of the React
// component so the host's canonical projection can be measured against this exact code
// rather than against a restatement of it. Shared because the host must now match it;
// deleted with the bridge at cutover.

import type { AgentSessionBackgroundTask } from './agent-session-background-task-wire'
import {
  AGENT_STATUS_MAX_SUBAGENTS,
  type AgentSubagentSnapshot,
  type AgentSubagentState
} from './agent-status-types'

/** Matches the wire-parse bound in `normalizeSubagentSnapshot`. */
export const SUBAGENT_ID_MAX_LENGTH = 64

export function subagentStateFromTask(task: AgentSessionBackgroundTask): AgentSubagentState {
  switch (task.state) {
    case 'waiting':
      return 'waiting'
    case 'blocked':
      return 'blocked'
    case 'done':
    case 'idle':
      return 'idle'
    case 'unverifiable':
      return 'unverifiable'
    // Absent state is an old host's live task; live means working here.
    case 'working':
    case 'monitoring':
    case undefined:
      return 'working'
  }
}

/** Sidebar children for a structured session: the agent-kind background tasks
 *  the host publishes, mapped to the sidebar's own subagent vocabulary rather
 *  than widening it. Kinds stay distinct — a backgrounded shell never counts
 *  as a subagent. */
export function subagentSnapshotsFromTasks(
  tasks: AgentSessionBackgroundTask[] | undefined
): AgentSubagentSnapshot[] | undefined {
  if (!tasks) {
    return undefined
  }
  const snapshots: AgentSubagentSnapshot[] = []
  for (const task of tasks) {
    const id = task.id.trim()
    if (task.kind !== 'agent' || id.length === 0 || id.length > SUBAGENT_ID_MAX_LENGTH) {
      continue
    }
    snapshots.push({
      id,
      state: subagentStateFromTask(task),
      startedAt: task.startedAt ?? 0,
      ...(task.name ? { agentType: task.name } : {}),
      ...(task.description ? { description: task.description } : {})
    })
    if (snapshots.length >= AGENT_STATUS_MAX_SUBAGENTS) {
      break
    }
  }
  return snapshots.length > 0 ? snapshots : undefined
}

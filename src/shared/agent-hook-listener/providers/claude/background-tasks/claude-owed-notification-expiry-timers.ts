import { mainAgentIdleSince } from '../../../main-agent-turn-state'
import { claudeRowHasUnlistedLiveWork } from '../lifecycle/claude-pane-hold-evidence'
import { buildClaudeCachedLeadStatusPayload } from '../lifecycle/claude-lifecycle-events'
import {
  CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS,
  claudeOwedTaskNotificationDeadline
} from './claude-owed-task-notifications'
import type { AgentLeaseExpiryProvider } from '../../../leases/agent-lease-expiry-timers'

/** Restates a Claude row whose owed task notifications expired without another event. */
export const CLAUDE_OWED_NOTIFICATION_LEASE_PROVIDER: AgentLeaseExpiryProvider = {
  lease(state, paneKey) {
    // Only an idle main agent has one: the lease does not run while it is in a turn.
    const idleSince = mainAgentIdleSince(state.claudeLeadStateByPaneKey.get(paneKey))
    const deadline =
      idleSince === undefined
        ? undefined
        : claudeOwedTaskNotificationDeadline(
            state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey),
            idleSince
          )
    return deadline === undefined
      ? undefined
      : { deadline, maxDelayMs: CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS }
  },
  settle(state, paneKey, row) {
    // Use the child-end fold so expired debt produces the same row as other Claude events.
    const payload = buildClaudeCachedLeadStatusPayload(state, undefined, paneKey, {})
    if (!payload) {
      return null
    }
    // Retain stored launch/owner fencing; timer restatement is neither a hook nor a new prompt.
    return {
      ...row,
      hasExplicitPrompt: undefined,
      hookEventName: undefined,
      claudeRunningNonAgentTask: claudeRowHasUnlistedLiveWork(state, paneKey),
      payload
    }
  }
}

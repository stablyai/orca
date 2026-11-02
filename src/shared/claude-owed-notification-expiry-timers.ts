import type { AgentHookEventPayload } from './agent-hook-listener/listener-event'
import type { HookListenerState } from './agent-hook-listener/listener-state'
import { mainAgentIdleSince } from './agent-hook-listener/main-agent-turn-state'
import { claudeRowHasUnlistedLiveWork } from './agent-hook-listener/providers/claude-pane-hold-evidence'
import { buildClaudeCachedLeadStatusPayload } from './agent-hook-listener/providers/claude-lifecycle-events'
import {
  CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS,
  claudeOwedTaskNotificationDeadline
} from './claude-owed-task-notifications'
import { CodexSubagentPollScheduler } from './codex-subagent-poll-scheduler'

type PublishRow = (row: AgentHookEventPayload) => void

/** Wake the local/remote execution host when owed notifications expire without another event. Re-read the pane so closed/moved leftovers are no-ops. */
export class ClaudeOwedNotificationExpiryTimers {
  private readonly wakeups = new CodexSubagentPollScheduler<PublishRow>(0, (paneKey, publish) =>
    this.restate(paneKey, publish)
  )

  constructor(private readonly state: HookListenerState) {}

  /** Call whenever a pane's row is stored; `publish` applies the restated row as the host would. */
  arm(paneKey: string, publish: PublishRow): void {
    const deadline = this.deadline(paneKey)
    if (deadline === undefined) {
      this.wakeups.clear(paneKey)
      return
    }
    // Cap delays after backward clock steps; restate rechecks the deadline and may re-arm.
    const delay = Math.min(
      CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS,
      Math.max(0, deadline - Date.now())
    )
    this.wakeups.schedule(paneKey, publish, delay)
  }

  clearAll(): void {
    this.wakeups.clearAll()
  }

  /** Only an idle main agent has one: the lease does not run while it is in a turn. */
  private deadline(paneKey: string): number | undefined {
    const idleSince = mainAgentIdleSince(this.state.claudeLeadStateByPaneKey.get(paneKey))
    return idleSince === undefined
      ? undefined
      : claudeOwedTaskNotificationDeadline(
          this.state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey),
          idleSince
        )
  }

  private restate(paneKey: string, publish: PublishRow): void {
    const deadline = this.deadline(paneKey)
    if (deadline === undefined) {
      return
    }
    // Why: a timer can fire before the wall clock reaches the deadline the lease is judged by.
    if (deadline > Date.now()) {
      this.arm(paneKey, publish)
      return
    }
    const row = this.state.lastStatusByPaneKey.get(paneKey)
    // Use the child-end fold so expired debt produces the same row as other Claude events.
    const payload = buildClaudeCachedLeadStatusPayload(this.state, undefined, paneKey, {})
    if (!row || !payload) {
      return
    }
    // Retain stored launch/owner fencing; timer restatement is neither a hook nor a new prompt.
    publish({
      ...row,
      hasExplicitPrompt: undefined,
      hookEventName: undefined,
      claudeRunningNonAgentTask: claudeRowHasUnlistedLiveWork(this.state, paneKey),
      payload
    })
  }
}

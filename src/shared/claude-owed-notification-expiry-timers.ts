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

/** Wakes the execution host (main for local panes, the relay for remote ones) when a pane held
 *  `working` only by owed Claude task notifications must be restated: nothing arrives when a
 *  notification is never sent. A firing re-reads the pane, so a wakeup left behind by a closed or
 *  moved pane is a no-op and needs no teardown of its own. */
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
    // Why capped: a wall clock stepped far back would otherwise ask for a delay setTimeout cannot
    // hold; restate() re-checks the deadline, so waking early only re-arms.
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
    // Why the builder a child's end re-emits through: the fold it runs is what gives up on the
    // expired notifications, and the row must read exactly like every other Claude row.
    const payload = buildClaudeCachedLeadStatusPayload(this.state, undefined, paneKey, {})
    if (!row || !payload) {
      return
    }
    // Why the stored row's envelope: its launch token and owner must reach the same fences a
    // hook's row does; like a transcript-poll restatement, it is no hook event and no new prompt.
    publish({
      ...row,
      hasExplicitPrompt: undefined,
      hookEventName: undefined,
      claudeRunningNonAgentTask: claudeRowHasUnlistedLiveWork(this.state, paneKey),
      payload
    })
  }
}

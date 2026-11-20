import type { AgentHookEventPayload } from '../../../listener-event'
import type { HookListenerState } from '../../../listener-state'
import { mainAgentIdleSince } from '../../../main-agent-turn-state'
import { claudeRowHasUnlistedLiveWork } from '../lifecycle/claude-pane-hold-evidence'
import { buildClaudeCachedLeadStatusPayload } from '../lifecycle/claude-lifecycle-events'
import {
  claudeUnclassifiedTurnEndDeadline,
  releaseClaudeUnclassifiedTurnEnd
} from '../lifecycle/claude-held-turn-end'
import {
  CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS,
  claudeOwedTaskNotificationDeadline
} from './claude-owed-task-notifications'

type PublishRow = (row: AgentHookEventPayload) => void

/** Wake the local/remote execution host when owed notifications expire, or a held turn end's prompt event never comes,
 * without another event. Re-read the pane so closed/moved leftovers are no-ops. */
export class ClaudeOwedNotificationExpiryTimers {
  // One timer per pane: arming is constant work however many panes wait. Row writes re-arm far more often than
  // deadlines move, so an unchanged deadline keeps its timer.
  private readonly wakeups = new Map<
    string,
    { deadline: number; timer: ReturnType<typeof setTimeout> }
  >()

  constructor(private readonly state: HookListenerState) {}

  /** Call whenever a pane's row is stored; `publish` applies the restated row as the host would. */
  arm(paneKey: string, publish: PublishRow): void {
    const deadline = this.deadline(paneKey)
    const armed = this.wakeups.get(paneKey)
    if (armed?.deadline === deadline) {
      return
    }
    if (armed) {
      clearTimeout(armed.timer)
      this.wakeups.delete(paneKey)
    }
    if (deadline === undefined) {
      return
    }
    // Cap delays after backward clock steps; restate rechecks the deadline and may re-arm.
    const delay = Math.min(
      CLAUDE_OWED_TASK_NOTIFICATION_LEASE_MS,
      Math.max(0, deadline - Date.now())
    )
    const timer = setTimeout(() => {
      if (this.wakeups.get(paneKey)?.timer !== timer) {
        return
      }
      this.wakeups.delete(paneKey)
      this.restate(paneKey, publish)
    }, delay)
    timer.unref?.()
    this.wakeups.set(paneKey, { deadline, timer })
  }

  clearAll(): void {
    for (const { timer } of this.wakeups.values()) {
      clearTimeout(timer)
    }
    this.wakeups.clear()
  }

  /** Only an idle main agent has one: neither the lease nor a held turn end runs while it is in a turn. */
  private deadline(paneKey: string): number | undefined {
    const lead = this.state.claudeLeadStateByPaneKey.get(paneKey)
    const idleSince = mainAgentIdleSince(lead)
    if (idleSince === undefined) {
      return undefined
    }
    const owed = claudeOwedTaskNotificationDeadline(
      this.state.claudeLaunchedBackgroundTasksByPaneKey.get(paneKey),
      idleSince
    )
    const held = claudeUnclassifiedTurnEndDeadline(lead)
    return owed === undefined || held === undefined ? (owed ?? held) : Math.min(owed, held)
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
    const lead = this.state.claudeLeadStateByPaneKey.get(paneKey)
    const heldDeadline = claudeUnclassifiedTurnEndDeadline(lead)
    // The turn's prompt event never arrived, so nothing says a task wakeup started it.
    if (lead && heldDeadline !== undefined && heldDeadline <= Date.now()) {
      releaseClaudeUnclassifiedTurnEnd(this.state, paneKey, lead)
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
    // A host whose publish stores no row would otherwise strand the pane's next deadline; a passed one stays passed.
    if ((this.deadline(paneKey) ?? 0) > Date.now()) {
      this.arm(paneKey, publish)
    }
  }
}

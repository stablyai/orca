import type { ClaudeBackgroundAgentTask } from '../../claude-background-task-inventory'
import {
  foldClaudeBackgroundTasksIntoRoster,
  reapUnconfirmedRestoredClaudeSubagents
} from '../../claude-subagent-roster'
import type { HookListenerState } from '../listener-state'
import { getOrCreateClaudeSubagentRoster, resolveClaudePaneStatus } from './claude-roster-state'

/** Retire the child work a main agent turn end proves gone, and answer, per child, whether its
 *  prompt outlives the turn: a child the roster tracked only while this event's inventory still
 *  leaves it working, and one the roster never tracked (refused at the cap) while the pane shows
 *  any child work at all. */
export function foldClaudeTurnEndChildWork(
  state: HookListenerState,
  paneKey: string,
  turnEnd: {
    backgroundTasks: { present: boolean; tasks: ClaudeBackgroundAgentTask[]; truncated: boolean }
    manualCompact: boolean
  }
): (agentId: string) => boolean {
  const trackedBefore = new Set(state.claudeSubagentRosterByPaneKey.get(paneKey)?.keys())
  const { backgroundTasks } = turnEnd
  // Why: background_tasks is trusted only where unambiguous (see foldClaudeBackgroundTasksIntoRoster) — teammates report "running" here even while idle.
  // Older Claude builds without the field keep the incrementally tracked roster.
  if (!turnEnd.manualCompact && backgroundTasks.present) {
    foldClaudeBackgroundTasksIntoRoster(
      getOrCreateClaudeSubagentRoster(state, paneKey),
      backgroundTasks.tasks,
      Date.now(),
      { inventoryComplete: !backgroundTasks.truncated }
    )
  }
  if (turnEnd.manualCompact) {
    // Why: a manual /compact only ever completes at an idle prompt, so a child that exists ONLY as
    // a disk snapshot has nothing live behind it and must not keep the pane spinning — that
    // restored child is what holds the stuck row STA-2915 actually reports. Everything else the
    // done-gate consults is live evidence (a child observed in this runtime, an unclassifiable
    // running background task, a registered session cron) and still holds the pane.
    const restoredRoster = state.claudeSubagentRosterByPaneKey.get(paneKey)
    if (
      restoredRoster &&
      reapUnconfirmedRestoredClaudeSubagents(restoredRoster) &&
      restoredRoster.size === 0
    ) {
      state.claudeSubagentRosterByPaneKey.delete(paneKey)
    }
  }
  const paneHasChildWork =
    resolveClaudePaneStatus(state, paneKey, { state: 'done' }).stateName !== 'done'
  const workingAfter = new Set<string>()
  for (const [id, tracked] of state.claudeSubagentRosterByPaneKey.get(paneKey) ?? []) {
    if (tracked.state === 'working') {
      workingAfter.add(id)
    }
  }
  return (agentId) => (trackedBefore.has(agentId) ? workingAfter.has(agentId) : paneHasChildWork)
}

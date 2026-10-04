// Which child work the worktree sidebar and the chat's strip list: running children only, by one
// rule, from every source they read (a CLI pane's hook roster and a chat session's records alike).
// A finished child is in the chat's transcript, not in either list. The host keeps every record;
// this picks from them on each read, so nothing here is stored and nothing can disagree with the
// store.

import { settledOwnersOfLiveWork } from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'

/** The one rule for what the sidebar and the strip list: a child that runs. A finished child whose
 *  own work still runs counts, since it reads monitoring and keeps that work's owner on screen. */
export function agentChildWorkIsRunning(child: {
  settled: boolean
  ownsLiveWork: boolean
}): boolean {
  return !child.settled || child.ownsLiveWork
}

/** A session's running children, in store order: what the sidebar and the strip list. */
export function structuredRunningChildWork(
  views: readonly AgentChildWorkView[]
): AgentChildWorkView[] {
  const owners = settledOwnersOfLiveWork(
    views.map((view) => ({
      id: view.id,
      membership: view.membership,
      ...(view.parentChildWorkId ? { ownerId: view.parentChildWorkId } : {})
    }))
  )
  return views.filter((view) =>
    agentChildWorkIsRunning({
      settled: view.membership === 'settled',
      ownsLiveWork: owners.has(view.id)
    })
  )
}

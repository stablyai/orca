// Sidebar/chat list running children from host records; finished history stays in transcripts. Derive on read without storing another roster.

import { settledOwnersOfLiveWork } from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'

/** Include settled owners of live work so monitoring rows retain that work's parent. */
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

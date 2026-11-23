import { settledOwnersOfLiveWork } from './agent-status-child-work-liveness'
import type { AgentChildWorkView } from './agent-status-child-work-view'

/** Include settled owners of live work so monitoring rows retain that work's parent. */
export function agentChildWorkIsRunning(child: {
  settled: boolean
  ownsLiveWork: boolean
}): boolean {
  return !child.settled || child.ownsLiveWork
}

/** A session's running children, in store order. */
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

export function structuredInspectableChildWork(
  views: readonly AgentChildWorkView[]
): AgentChildWorkView[] {
  const running = new Set(structuredRunningChildWork(views).map((view) => view.id))
  return views.filter((view) => view.kind === 'agent' || running.has(view.id))
}

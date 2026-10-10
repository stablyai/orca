import { agentChildWorkViewOffersStop } from './agent-child-work-stop-targets'
import {
  agentChildWorkFencesEqual,
  type AgentChildWorkInvocationFence
} from './agent-child-work-invocation'
import type { AgentChildWorkView } from './agent-status-child-work-view'

export type AgentSessionBackgroundStopTarget = {
  kind: 'background-tasks'
  tasks: { id: string; invocation: AgentChildWorkInvocationFence }[]
}

export function agentSessionBackgroundStopTarget(
  views: readonly AgentChildWorkView[] | undefined,
  taskId?: string
): AgentSessionBackgroundStopTarget {
  return {
    kind: 'background-tasks',
    tasks: (views ?? [])
      .filter(
        (view) =>
          agentChildWorkViewOffersStop(view) && (taskId === undefined || view.providerId === taskId)
      )
      .map((view) => ({ id: view.id, invocation: { ...view.invocation } }))
  }
}

/** Provider handles can be reused; the host's child identity and invocation must still match. */
export function targetedAgentSessionBackgroundTaskIds(
  views: readonly AgentChildWorkView[] | undefined,
  target: AgentSessionBackgroundStopTarget,
  taskId?: string
): string[] {
  return (views ?? []).flatMap((view) =>
    agentChildWorkViewOffersStop(view) &&
    view.providerId !== undefined &&
    (taskId === undefined || view.providerId === taskId) &&
    target.tasks.some(
      (task) => task.id === view.id && agentChildWorkFencesEqual(task.invocation, view.invocation)
    )
      ? [view.providerId]
      : []
  )
}

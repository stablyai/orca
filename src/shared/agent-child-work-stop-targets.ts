// UI, command admission and host Stop resolution share the same child records and targeting rules.

import type { AgentChildWorkOutcome } from './agent-status-child-work'
import type { AgentChildWorkEvidence } from './agent-status-child-work-evidence'
import type { AgentChildWorkView } from './agent-status-child-work-view'

/** Which stop controls a provider honours. Provider capability, not a fact about any one task. */
export type AgentSessionBackgroundTaskStops = {
  /** A stop can name one task. */
  supportsTaskStop: boolean
  /** An untargeted "stop everything" exists. */
  supportsStopAll: boolean
}

/** Offer targeted Stop only for live, stoppable children with provider IDs; admission uses the same rule. */
export function agentChildWorkViewOffersStop(view: AgentChildWorkView): boolean {
  return view.membership !== 'settled' && view.stoppable && view.providerId !== undefined
}

/** Target taskId, or all children offered targeted Stop when no taskId is given. */
export function agentChildWorkStopTargets(
  views: readonly AgentChildWorkView[] | undefined,
  taskId?: string
): (AgentChildWorkView & { providerId: string })[] {
  return (views ?? []).flatMap((view) =>
    agentChildWorkViewOffersStop(view) &&
    view.providerId !== undefined &&
    (taskId === undefined || view.providerId === taskId)
      ? [{ ...view, providerId: view.providerId }]
      : []
  )
}

/** Provider-accepted Stop; outcome describes the captured run when reported, including already finished runs. */
export type AgentChildWorkStopAcknowledgement = {
  taskId: string
  outcome?: AgentChildWorkOutcome
}

/** Bind acknowledgements to lifetimes captured before send so late replies cannot end a restarted run. */
export function agentChildWorkStopEvidence(
  targets: readonly (AgentChildWorkView & { providerId: string })[],
  acknowledged: readonly AgentChildWorkStopAcknowledgement[] | undefined,
  observedAt: number
): AgentChildWorkEvidence[] {
  return (acknowledged ?? []).flatMap((ack) => {
    const target = targets.find((view) => view.providerId === ack.taskId)
    return target
      ? [
          {
            type: 'stop-acknowledged' as const,
            observedAt,
            childWorkId: target.id,
            handleId: target.providerId,
            invocation: { ...target.invocation },
            ...(ack.outcome !== undefined ? { outcome: ack.outcome } : {})
          }
        ]
      : []
  })
}

// What a background Stop reaches, read from the host's child records: the strip draws a row's Stop
// by this rule, conversation-command admission asks for a stop by it, and the host resolves the
// provider ids a Stop sends by it.

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

/** The strip offers this child its own stop: it is live, stoppable, and addressable by the id a
 *  targeted stop names. The host's command admission asks the same question of the same views. */
export function agentChildWorkViewOffersStop(view: AgentChildWorkView): boolean {
  return view.membership !== 'settled' && view.stoppable && view.providerId !== undefined
}

/** What a background Stop reaches: the child `taskId` names, or, with none, every child the strip
 *  offers its own stop. Resolved from the same records the strip and admission read. */
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

/** A child the provider accepted a Stop for. `outcome` is the run's own ending when the answer
 *  named one, as a stop of a child that had already finished does. */
export type AgentChildWorkStopAcknowledgement = {
  taskId: string
  outcome?: AgentChildWorkOutcome
}

/** Each accepted Stop as evidence about the run the host sent it to, captured before it was sent,
 *  so an acknowledgement that lands after a new run started cannot end that one. */
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

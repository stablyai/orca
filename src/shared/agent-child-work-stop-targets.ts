// What a background Stop reaches, read from the host's child records: the strip draws a row's Stop
// by this rule, conversation-command admission asks for a stop by it, and the host resolves the
// provider ids a Stop sends by it.

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

/** The provider ids a background Stop reaches: the one `taskId` names, or, with none, every child
 *  the strip offers its own stop. Resolved from the same records the strip and admission read. */
export function agentChildWorkStopTargets(
  views: readonly AgentChildWorkView[] | undefined,
  taskId?: string
): string[] {
  return (views ?? []).flatMap((view) =>
    agentChildWorkViewOffersStop(view) &&
    view.providerId !== undefined &&
    (taskId === undefined || view.providerId === taskId)
      ? [view.providerId]
      : []
  )
}

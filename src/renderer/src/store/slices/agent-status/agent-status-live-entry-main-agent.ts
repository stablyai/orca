import { canonicalOrchestrationForRow } from '@/runtime/visible-agent-orchestration'
import {
  mainAgentStatusEqual,
  type AgentMainAgentStatus
} from '../../../../../shared/main-agent-status'
import {
  effectiveAgentStatusOwnerType,
  type AgentStatusEntry
} from '../../../../../shared/agent-status-types'
import type { AgentStatusObservationOrigin } from '../../../../../shared/agent-status-observation'
import type { AppState } from '../../types'
import type { AgentStatusPayload } from './agent-status-contract'
import { mergeCurrentOrchestrationContext } from './agent-status-orchestration-context'

/** Byte/launch writers omit mainAgent; hook omission authoritatively clears it for mobile/CLI parity. */
const MAIN_AGENT_BLIND_ORIGINS: ReadonlySet<AgentStatusObservationOrigin> = new Set([
  'osc',
  'title',
  'launch',
  'process'
])

/** Clockless OSC/launch repaints retain mainAgent within unchanged state, like main ingest. Reuse equal objects for reference subscribers. */
export function resolveAgentStatusLiveEntryMainAgent(
  existing: AgentStatusEntry | undefined,
  payload: Pick<AgentStatusPayload, 'state' | 'mainAgent' | 'observation'>,
  agentType: AgentStatusEntry['agentType']
): AgentMainAgentStatus | undefined {
  const blindWriter =
    payload.observation !== undefined && MAIN_AGENT_BLIND_ORIGINS.has(payload.observation.origin)
  const next =
    payload.mainAgent ??
    (blindWriter && existing?.state === payload.state && existing.agentType === agentType
      ? existing.mainAgent
      : undefined)
  return mainAgentStatusEqual(existing?.mainAgent, next) ? existing?.mainAgent : next
}

export function resolveAgentStatusLiveEntryOrchestration(
  state: AppState,
  paneKey: string,
  existing: AgentStatusEntry | undefined,
  payload: Pick<AgentStatusPayload, 'state' | 'orchestration'>
): AgentStatusEntry['orchestration'] {
  const runtimeOrchestration = canonicalOrchestrationForRow(state, paneKey)
  const runtimeMergedOrchestration = runtimeOrchestration
    ? mergeCurrentOrchestrationContext(existing?.orchestration, runtimeOrchestration)
    : undefined
  const payloadMergedOrchestration = payload.orchestration
    ? mergeCurrentOrchestrationContext(
        runtimeMergedOrchestration ?? existing?.orchestration,
        payload.orchestration
      )
    : undefined
  return (
    payloadMergedOrchestration ??
    runtimeMergedOrchestration ??
    (payload.state === 'done' ? existing?.orchestration : undefined)
  )
}

export function resolveAgentStatusLiveEntryPaneOwner(args: {
  existing: AgentStatusEntry | undefined
  sameTerminal: boolean
  incomingAgentType: AgentStatusEntry['agentType']
  incomingPaneOwner: AgentStatusEntry['paneOwner']
  foreground: AppState['paneForegroundAgentByPaneKey'][string] | undefined
}): {
  suppressedByPaneOwner: boolean
  resolvePaneOwner: (
    resolvedAgentType: AgentStatusEntry['agentType']
  ) => AgentStatusEntry['paneOwner']
} {
  const { existing, sameTerminal, incomingAgentType, incomingPaneOwner, foreground } = args
  const existingOwnerAgent = effectiveAgentStatusOwnerType(existing)
  const foregroundLeftExistingOwner = Boolean(
    foreground &&
    (foreground.shellForeground ||
      (foreground.agentEvidence === 'process-read' &&
        foreground.agent !== null &&
        foreground.agent !== existingOwnerAgent))
  )
  const suppressedByPaneOwner =
    sameTerminal &&
    !foregroundLeftExistingOwner &&
    Boolean(
      existingOwnerAgent &&
      existingOwnerAgent !== 'unknown' &&
      incomingAgentType &&
      incomingAgentType !== 'unknown' &&
      incomingAgentType !== existingOwnerAgent &&
      (incomingPaneOwner?.agent === existingOwnerAgent ||
        (foreground &&
          !foreground.shellForeground &&
          !foreground.routingRevoked &&
          foreground.agent === existingOwnerAgent &&
          incomingPaneOwner?.agent !== incomingAgentType))
    )
  return {
    suppressedByPaneOwner,
    resolvePaneOwner: (resolvedAgentType) =>
      (foregroundLeftExistingOwner &&
      incomingPaneOwner?.agent === existingOwnerAgent &&
      incomingPaneOwner.agent !== resolvedAgentType
        ? undefined
        : incomingPaneOwner) ??
      (sameTerminal &&
      !foregroundLeftExistingOwner &&
      existing?.paneOwner &&
      existing.paneOwner.agent === resolvedAgentType
        ? existing.paneOwner
        : undefined)
  }
}

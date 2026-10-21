import type { AgentStatusIpcPayload } from '../../../../shared/agent-status-types'
import type { ProgramStatusFacet } from '../../../../shared/program-status/facet'
import type { AppState } from '@/store/types'
import type {
  AgentProgramStatusUpdate,
  AgentProviderSessionUpdate
} from '@/store/slices/agent-status'
import type {
  AgentStatusApplyResult,
  AgentStatusBatchContext,
  PendingAgentStatusEvent
} from './agent-status-bridge-types'

// Events that patch one aspect of an already-routed row; they never create, re-time or notify one.

/** Carry a facet tick for a not-yet-routable pane on its pending state rows. */
export function foldProgramStatusIntoPendingRows(
  pendingAgentStatusEvents: PendingAgentStatusEvent[],
  paneKey: string,
  programStatus: ProgramStatusFacet | null
): void {
  for (const pending of pendingAgentStatusEvents) {
    if (pending.data.paneKey === paneKey && pending.data.programStatusOnly !== true) {
      const { programStatus: _stale, ...rest } = pending.data
      pending.data = programStatus ? { ...rest, programStatus } : rest
    }
  }
}

export function applyProgramStatusOnlyUpdate(
  store: AppState,
  batch: AgentStatusBatchContext | undefined,
  paneKey: string,
  programStatus: ProgramStatusFacet | null
): AgentStatusApplyResult {
  const update: AgentProgramStatusUpdate = { kind: 'programStatus', paneKey, programStatus }
  const applied = batch
    ? batch.transaction.apply(update)
    : store.setAgentProgramStatus(paneKey, programStatus)
  return applied ? 'applied' : 'dropped'
}

export function applyProviderSessionOnlyUpdate(args: {
  store: AppState
  batch: AgentStatusBatchContext | undefined
  data: AgentStatusIpcPayload
  paneKey: string
  routing: NonNullable<AgentProviderSessionUpdate['routing']>
}): AgentStatusApplyResult {
  const { store, batch, data, paneKey, routing } = args
  if (!data.providerSession || data.agentType !== 'pi') {
    return 'dropped'
  }
  const update: AgentProviderSessionUpdate = {
    kind: 'providerSession',
    paneKey,
    agent: 'pi',
    providerSession: data.providerSession,
    timing: { updatedAt: data.receivedAt },
    routing,
    metadata: data.launchToken ? { launchToken: data.launchToken } : undefined
  }
  if (batch) {
    return batch.transaction.apply(update) ? 'applied' : 'dropped'
  }
  store.recordAgentProviderSession(
    update.paneKey,
    update.agent,
    update.providerSession,
    update.timing,
    update.routing,
    update.metadata
  )
  return 'applied'
}

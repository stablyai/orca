import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { agentTypeToIconAgent } from '../../../../shared/agent-type-icon-agent'
import type { TerminalSurface, WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { isClientOwnedAgentStatus, isMirroredAgentStatusOwnedBy } from './agent-status-primitives'
import { writableWebSessionTabsRecord } from './state-equality-core'

export function matchesMirroredTerminal(
  entry: AgentStatusEntry,
  surface: TerminalSurface
): boolean {
  return entry.terminalHandle === undefined || entry.terminalHandle === surface.terminal
}

/** A surviving shell's authoritative omission retires display copies, not launch or recovery state. */
export function buildMirroredAgentRetentionPatch(
  state: WebSessionTabsSyncState,
  readySurfaces: ReadonlyMap<string, TerminalSurface>,
  accepted: ReadonlyMap<string, AgentStatusEntry>,
  environmentId: string,
  worktreeId: string,
  batchContext?: WebSessionTabsBatchContext
): Partial<
  Pick<WebSessionTabsSyncState, 'retainedAgentsByPaneKey' | 'retentionSuppressedPaneKeys'>
> {
  const patch: Partial<
    Pick<WebSessionTabsSyncState, 'retainedAgentsByPaneKey' | 'retentionSuppressedPaneKeys'>
  > = {}
  for (const [paneKey, surface] of readySurfaces) {
    if (surface.agentStatus) {
      continue
    }
    const live = state.agentStatusByPaneKey[paneKey]
    if (isClientOwnedAgentStatus(paneKey, live)) {
      continue
    }
    const owned = (entry: AgentStatusEntry): boolean =>
      !!agentTypeToIconAgent(entry.agentType) &&
      isMirroredAgentStatusOwnedBy(entry, environmentId, worktreeId) &&
      matchesMirroredTerminal(entry, surface)
    const retained = state.retainedAgentsByPaneKey?.[paneKey]
    if (retained && owned(retained.entry)) {
      patch.retainedAgentsByPaneKey ??= writableWebSessionTabsRecord(
        state,
        'retainedAgentsByPaneKey',
        batchContext
      )
      delete patch.retainedAgentsByPaneKey[paneKey]
    }
    if (
      live &&
      live.mirroredEvidenceReceivedAt !== undefined &&
      owned(live) &&
      !state.retentionSuppressedPaneKeys?.[paneKey]
    ) {
      patch.retentionSuppressedPaneKeys ??= writableWebSessionTabsRecord(
        state,
        'retentionSuppressedPaneKeys',
        batchContext
      )
      patch.retentionSuppressedPaneKeys[paneKey] = true
    }
  }
  // A fresh host row re-derives liveness even if React never observed the prior disappearance.
  for (const paneKey of accepted.keys()) {
    if ((patch.retentionSuppressedPaneKeys ?? state.retentionSuppressedPaneKeys)?.[paneKey]) {
      patch.retentionSuppressedPaneKeys ??= writableWebSessionTabsRecord(
        state,
        'retentionSuppressedPaneKeys',
        batchContext
      )
      delete patch.retentionSuppressedPaneKeys[paneKey]
    }
  }
  return patch
}

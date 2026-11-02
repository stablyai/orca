import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { agentTypeToIconAgent } from '../../../../shared/agent-type-icon-agent'
import type { TerminalSurface, WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import { isClientOwnedAgentStatus, isMirroredAgentStatusOwnedBy } from './agent-status-primitives'
import { writableWebSessionTabsRecord } from './state-equality-core'

function matchesMirroredTerminal(entry: AgentStatusEntry, surface: TerminalSurface): boolean {
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
    const clientOwnsStatus: boolean = isClientOwnedAgentStatus(paneKey, live)
    if (clientOwnsStatus) {
      continue
    }
    const owned = (entry: AgentStatusEntry): boolean =>
      !!agentTypeToIconAgent(entry.agentType) &&
      isMirroredAgentStatusOwnedBy(entry, environmentId, worktreeId)
    const retained = state.retainedAgentsByPaneKey?.[paneKey]
    const retiresRetained =
      retained && owned(retained.entry) && matchesMirroredTerminal(retained.entry, surface)
    if (retiresRetained) {
      const nextRetained = (patch.retainedAgentsByPaneKey ??= writableWebSessionTabsRecord(
        state,
        'retainedAgentsByPaneKey',
        batchContext
      ))
      delete nextRetained[paneKey]
    }
    if (
      (retiresRetained || (live && live.mirroredEvidenceReceivedAt !== undefined && owned(live))) &&
      !state.retentionSuppressedPaneKeys?.[paneKey]
    ) {
      const nextSuppressed = (patch.retentionSuppressedPaneKeys ??= writableWebSessionTabsRecord(
        state,
        'retentionSuppressedPaneKeys',
        batchContext
      ))
      nextSuppressed[paneKey] = true
    }
  }
  // A fresh host row ends suppression and re-derives session dating even after retention effects.
  for (const paneKey of accepted.keys()) {
    if ((patch.retentionSuppressedPaneKeys ?? state.retentionSuppressedPaneKeys)?.[paneKey]) {
      const nextSuppressed = (patch.retentionSuppressedPaneKeys ??= writableWebSessionTabsRecord(
        state,
        'retentionSuppressedPaneKeys',
        batchContext
      ))
      delete nextSuppressed[paneKey]
    }
  }
  return patch
}

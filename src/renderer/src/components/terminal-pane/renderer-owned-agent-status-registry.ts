import type { AgentStatusEntry } from '../../../../shared/agent-status-types'

/** Fence host mirroring only after renderer byte-derived status proves its claim; otherwise two writers flap the same pane row between working/generated titles and host defaults. */
type RendererOwnedAgentStatusPane = {
  environmentId: string
  hasClientWrite: boolean
}

const panesByPaneKey = new Map<string, RendererOwnedAgentStatusPane>()

/** Claims the pane and returns its release; call the release on teardown. */
export function registerRendererOwnedAgentStatusPane(
  paneKey: string,
  environmentId: string
): () => void {
  const existing = panesByPaneKey.get(paneKey)
  // Preserve earned claims across remount unless runtime ownership changes to a different byte stream.
  const entry: RendererOwnedAgentStatusPane = {
    environmentId,
    hasClientWrite: existing?.environmentId === environmentId && existing.hasClientWrite
  }
  panesByPaneKey.set(paneKey, entry)
  // Identity-check release because successor mounts share paneKey; stale deletion would remove a claim that writes cannot recreate.
  return () => {
    if (panesByPaneKey.get(paneKey) === entry) {
      panesByPaneKey.delete(paneKey)
    }
  }
}

export function markRendererOwnedAgentStatusWrite(paneKey: string): void {
  const existing = panesByPaneKey.get(paneKey)
  if (!existing || existing.hasClientWrite) {
    return
  }
  existing.hasClientWrite = true
}

/** True once this renderer both claimed the pane and actually wrote its status. */
export function isClientAuthoritativeAgentStatusPane(paneKey: string): boolean {
  return panesByPaneKey.get(paneKey)?.hasClientWrite === true
}

/** A byte write replacing an adopted host row cannot be ordered against the host's clock. */
export function resolveRendererOwnedAgentStatusTiming(
  existing: Pick<AgentStatusEntry, 'mirroredEvidenceReceivedAt'> | undefined
): { allowOlderTimestamp: true } | undefined {
  return existing?.mirroredEvidenceReceivedAt !== undefined
    ? { allowOlderTimestamp: true }
    : undefined
}

export function _getRendererOwnedAgentStatusPaneCountForTest(): number {
  return panesByPaneKey.size
}

export function resetRendererOwnedAgentStatusPanesForTests(): void {
  panesByPaneKey.clear()
}

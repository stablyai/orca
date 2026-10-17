import type { AppState } from '../types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getPtyExecutionHost } from '../../../../shared/terminal-execution-host'
import { collectPtyIdsForTab } from '../slices/terminal-tab-retirement'

/** `foreign`: off this host, owner unresolved. `null`: no evidence either way. */
export type HostEvidence = ExecutionHostId | 'non-runtime' | 'foreign' | null

export function isRuntimeHost(hostId: ExecutionHostId): boolean {
  return parseExecutionHostId(hostId)?.kind === 'runtime'
}

export function ptyHostEvidence(ptyId: string): HostEvidence {
  const host = getPtyExecutionHost(ptyId)
  // Why: SSH and runtime PTY ids name their host, so an unprefixed one runs on a local/SSH host.
  return host ?? 'non-runtime'
}

/** Evidence that names a host other than the removed one; unknown evidence names none. */
function contradictsRemovedHost(evidence: HostEvidence, removedHostId: ExecutionHostId): boolean {
  if (evidence === null) {
    return false
  }
  // Why foreign contradicts: an off-host PTY with no named owner cannot be proven the removed host's.
  return evidence === 'non-runtime' ? isRuntimeHost(removedHostId) : evidence !== removedHostId
}

export function belongsToRemovedHost(
  evidence: HostEvidence,
  removedHostId: ExecutionHostId,
  survivingHostIds: readonly ExecutionHostId[]
): boolean {
  if (evidence === null || evidence === 'foreign') {
    return false
  }
  if (evidence !== 'non-runtime') {
    return evidence === removedHostId
  }
  // Non-runtime evidence names one host only when exactly one side is a local/SSH host.
  return !isRuntimeHost(removedHostId) && survivingHostIds.every(isRuntimeHost)
}

/** One entry per PTY id a terminal tab names, live or hinted. */
export function terminalTabPtyEvidence(
  state: Parameters<typeof collectPtyIdsForTab>[0] & Pick<AppState, 'ptyIdsByTabId'>,
  tabId: string,
  rowPtyId: string | null
): HostEvidence[] {
  // Why every source: a restored tab can name its host only in its layout or reconnect maps.
  const live = new Set([...(state.ptyIdsByTabId[tabId] ?? []), ...(rowPtyId ? [rowPtyId] : [])])
  // Why: an unprefixed id only in a layout or reconnect map may be a host-native hint.
  return collectPtyIdsForTab(state, tabId, rowPtyId).map((ptyId) => {
    const entry = ptyHostEvidence(ptyId)
    return entry === 'non-runtime' && !live.has(ptyId) ? null : entry
  })
}

/**
 * Whether a terminal tab is only `hostId`'s. Why every: one pane on another host means the tab
 * is not only this host's; a stamp still yields to a PTY that names another host.
 */
export function terminalTabBelongsToHost(
  stamped: HostEvidence | undefined,
  evidence: readonly HostEvidence[],
  hostId: ExecutionHostId,
  survivingHostIds: readonly ExecutionHostId[],
  canonical: (evidence: HostEvidence) => HostEvidence
): boolean {
  return stamped
    ? stamped === hostId &&
        evidence.every((entry) => !contradictsRemovedHost(canonical(entry), hostId))
    : evidence.length > 0 &&
        evidence.every((entry) => belongsToRemovedHost(canonical(entry), hostId, survivingHostIds))
}

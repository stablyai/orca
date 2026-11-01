import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey, makePaneKey, isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isClientAuthoritativeAgentStatusPane } from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { normalizeCompatibleAgentStatusEntryForOwner } from '../../../../shared/agent-title-owner'
import { resolvePaneAgentOwnerRecord } from '../../../../shared/pane-agent-owner'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'
import type { TerminalSurface, WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import type { RetiredTerminalTabSweepState } from '../../store/slices/retired-terminal-tab-state-sweep'
import { buildRetiredTerminalTabStateSweepPatch } from '../../store/slices/retired-terminal-tab-state-sweep'
import { isMirroredTerminalSurfaceId } from './terminal-surfaces'
import { isAgentStatusFresh } from './state-equality-core'

export function isMirroredAgentStatusOwnedBy(
  entry: AgentStatusEntry,
  environmentId: string,
  worktreeId: string
): boolean {
  return (
    entry.worktreeId === worktreeId &&
    (entry.connectionId === environmentId || entry.connectionId == null)
  )
}

export function toMirroredPaneKey(
  surface: TerminalSurface,
  leafId = surface.leafId
): string | null {
  if (!isTerminalLeafId(leafId)) {
    return null
  }
  return makePaneKey(toWebTerminalSurfaceTabId(surface.parentTabId), leafId)
}

export function remapHostAgentStatus(
  surface: TerminalSurface,
  retainedSurface?: TerminalSurface
): AgentStatusEntry | null {
  if (!surface.agentStatus) {
    return null
  }
  const paneKey = toMirroredPaneKey(surface, retainedSurface?.leafId)
  if (!paneKey) {
    return null
  }
  const ownerRecord = resolvePaneAgentOwnerRecord({
    launchAgent: retainedSurface?.launchAgent ?? surface.launchAgent,
    hookAgent: surface.agentStatus.agentType
  })
  return {
    ...normalizeCompatibleAgentStatusEntryForOwner(surface.agentStatus, ownerRecord?.agent, {
      ownerIsLaunch: ownerRecord?.ownerIsLaunch === true
    }),
    paneKey,
    tabId: toWebTerminalSurfaceTabId(surface.parentTabId)
  }
}

export function isMirroredAgentPaneKeyForTabs(
  paneKey: string,
  tabIds: ReadonlySet<string>
): boolean {
  const parsed = parsePaneKey(paneKey)
  return parsed !== null && tabIds.has(parsed.tabId)
}

/** HTTP-hook permission/question states never reach PTY bytes and must pierce client ownership. */
export function hostAgentStatusPiercesClientAuthority(entry: AgentStatusEntry): boolean {
  // Why: a row restored across a host restart is unverifiable, so it never outranks live bytes.
  return (
    entry.restoredUnconfirmed !== true &&
    (entry.state === 'blocked' || entry.interactivePrompt != null)
  )
}

/** Only the current byte-derived row can fence host snapshots; adopting a host row yields authority. */
export function isClientOwnedAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined
): existing is AgentStatusEntry {
  return (
    existing !== undefined &&
    existing.mirroredEvidenceReceivedAt === undefined &&
    isClientAuthoritativeAgentStatusPane(paneKey)
  )
}

/** When host and client compete, stale client status yields to host; ownership alone still protects against host omission. */
export function isFencedClientAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined,
  now: number
): existing is AgentStatusEntry {
  return isClientOwnedAgentStatus(paneKey, existing) && isAgentStatusFresh(existing, now)
}

/** A fresh client byte writer keeps the pane unless the host carries a host-only state class. */
export function clientAgentStatusFencesHost(
  paneKey: string,
  existing: AgentStatusEntry | undefined,
  hostEntry: AgentStatusEntry | null | undefined,
  now: number
): boolean {
  return (
    isFencedClientAgentStatus(paneKey, existing, now) &&
    !(hostEntry && hostAgentStatusPiercesClientAuthority(hostEntry))
  )
}

export function batchAgentPaneKeysForTabs(
  state: WebSessionTabsSyncState,
  tabIds: ReadonlySet<string>,
  batchContext?: WebSessionTabsBatchContext
): string[] {
  if (!batchContext) {
    return Object.keys(state.agentStatusByPaneKey)
  }
  if (!batchContext.agentPaneKeysByTabId) {
    batchContext.agentPaneKeysByTabId = new Map()
    for (const paneKey of Object.keys(state.agentStatusByPaneKey)) {
      const tabId = parsePaneKey(paneKey)?.tabId
      if (!tabId) {
        continue
      }
      const paneKeys = batchContext.agentPaneKeysByTabId.get(tabId) ?? new Set<string>()
      paneKeys.add(paneKey)
      batchContext.agentPaneKeysByTabId.set(tabId, paneKeys)
    }
  }
  return [...tabIds].flatMap((tabId) => [...(batchContext.agentPaneKeysByTabId?.get(tabId) ?? [])])
}

export function updateBatchAgentPaneKey(
  paneKey: string,
  present: boolean,
  batchContext?: WebSessionTabsBatchContext
): void {
  batchContext?.changedAgentPaneKeys?.add(paneKey)
  const tabId = parsePaneKey(paneKey)?.tabId
  const index = batchContext?.agentPaneKeysByTabId
  if (!tabId || !index) {
    return
  }
  if (present) {
    const paneKeys = index.get(tabId) ?? new Set<string>()
    paneKeys.add(paneKey)
    index.set(tabId, paneKeys)
    return
  }
  const paneKeys = index.get(tabId)
  paneKeys?.delete(paneKey)
  if (paneKeys?.size === 0) {
    index.delete(tabId)
  }
}

// Closed-tab markers never expire and reject writes; returning stable IDs must lift them or status is lost permanently.
export function buildRemirroredClosedTabMarkerLiftPatch(
  recentlyClosedAgentStatusTabIds: WebSessionTabsSyncState['recentlyClosedAgentStatusTabIds'],
  mirroredTerminalIds: ReadonlySet<string>
): Partial<WebSessionTabsSyncState> | null {
  let next: WebSessionTabsSyncState['recentlyClosedAgentStatusTabIds'] | null = null
  for (const tabId of mirroredTerminalIds) {
    if (tabId in (recentlyClosedAgentStatusTabIds ?? {})) {
      next ??= { ...recentlyClosedAgentStatusTabIds }
      delete next[tabId]
    }
  }
  return next ? { recentlyClosedAgentStatusTabIds: next } : null
}

/** Host retraction needs closeTab’s sweep or client-owned status/retained promotions outlive the tab as ghosts (STA-4593, STA-3107). */
export function buildRetractedMirroredTabSweepPatch(
  state: WebSessionTabsSyncState,
  nextTabsByWorktree: WebSessionTabsSyncState['tabsByWorktree'],
  agentStatusPatch: Pick<
    WebSessionTabsSyncState,
    'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'
  > | null,
  removedTerminalResourceIds: readonly string[],
  scopedPaneKeysByTabId: ReadonlyMap<string, ReadonlySet<string>>,
  batchContext?: WebSessionTabsBatchContext
): Partial<WebSessionTabsSyncState> | null {
  // Sweep only vanished mirrors; local/provisional entries are renamed and must retain status.
  const retractedTabIds = removedTerminalResourceIds.filter(isMirroredTerminalSurfaceId)
  if (retractedTabIds.length === 0) {
    return null
  }
  let sweepState: RetiredTerminalTabSweepState = {
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey ?? {},
    activityClearedAtByPaneKey: state.activityClearedAtByPaneKey ?? {},
    agentConversationsByPaneKey: state.agentConversationsByPaneKey ?? {},
    agentLaunchConfigByPaneKey: state.agentLaunchConfigByPaneKey ?? {},
    agentStatusByPaneKey: agentStatusPatch?.agentStatusByPaneKey ?? state.agentStatusByPaneKey,
    agentStatusEpoch: agentStatusPatch?.agentStatusEpoch ?? state.agentStatusEpoch,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId ?? {},
    manuallyUnreadTurnsByPaneKey: state.manuallyUnreadTurnsByPaneKey ?? {},
    paneForegroundAgentByPaneKey: state.paneForegroundAgentByPaneKey ?? {},
    recentlyClosedAgentStatusTabIds: state.recentlyClosedAgentStatusTabIds ?? {},
    recentlyRetiredAgentStatusPaneKeys: state.recentlyRetiredAgentStatusPaneKeys ?? {},
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey ?? {},
    retentionSuppressedPaneKeys: state.retentionSuppressedPaneKeys ?? {},
    sortEpoch: agentStatusPatch?.sortEpoch ?? state.sortEpoch,
    // Keep the sweep state consistent with the accepted host inventory.
    tabsByWorktree: nextTabsByWorktree,
    unifiedTabsByWorktree: state.unifiedTabsByWorktree
  }
  // Retraction may rekey live panes; retain activity cutoffs so republication cannot replay user-cleared activity (ssh-execution-boundary).
  const previousAgentStatuses = sweepState.agentStatusByPaneKey
  let sweep: Partial<RetiredTerminalTabSweepState> | null = null
  for (const tabId of retractedTabIds) {
    const paneKeys = scopedPaneKeysByTabId.get(tabId)
    const patch = buildRetiredTerminalTabStateSweepPatch(sweepState, [tabId], undefined, {
      preserveActivityClearedState: true,
      changedAgentPaneKeys: batchContext?.changedAgentPaneKeys,
      ...(paneKeys ? { paneKeys } : {})
    })
    if (patch) {
      sweep ??= {}
      Object.assign(sweep, patch)
      sweepState = { ...sweepState, ...patch }
    }
  }
  if (!sweep?.agentStatusByPaneKey || !batchContext) {
    return sweep ?? null
  }
  // Update the batch’s final record copy too or republication undoes the sweep.
  const mutableState = state as unknown as Record<string, unknown>
  mutableState.agentStatusByPaneKey = sweep.agentStatusByPaneKey
  batchContext.changedRecords.add('agentStatusByPaneKey')
  for (const paneKey of Object.keys(previousAgentStatuses)) {
    if (!(paneKey in sweep.agentStatusByPaneKey)) {
      updateBatchAgentPaneKey(paneKey, false, batchContext)
    }
  }
  return sweep
}

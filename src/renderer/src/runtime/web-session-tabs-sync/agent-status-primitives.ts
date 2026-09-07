import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey, makePaneKey, isTerminalLeafId } from '../../../../shared/stable-pane-id'
import { isClientAuthoritativeAgentStatusPane } from '@/components/terminal-pane/renderer-owned-agent-status-registry'
import { normalizeCompatibleAgentStatusEntryForOwner } from '../../../../shared/agent-title-owner'
import { resolvePaneAgentOwnerRecord } from '../../../../shared/pane-agent-owner'
import { toWebTerminalSurfaceTabId } from '../web-runtime-session'
import type { TerminalSurface, WebSessionTabsBatchContext, WebSessionTabsSyncState } from './state'
import type { RetiredTerminalTabSweepState } from '../../store/slices/retired-terminal-tab-state-sweep'
import { buildRetiredTerminalTabStateSweepPatch } from '../../store/slices/retired-terminal-tab-state-sweep'
import { isMirroredTerminalSurfaceId } from './terminal-surfaces'
import { isAgentStatusFresh } from './state-equality-core'

export function toMirroredPaneKey(
  surface: TerminalSurface,
  leafId = surface.leafId
): string | null {
  if (!isTerminalLeafId(leafId)) {
    return null
  }
  return makePaneKey(toWebTerminalSurfaceTabId(surface.parentTabId), leafId)
}

/** Normalises and mirrors agent status updates from the host payload, preserving ownership metadata. */
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

/** Host states the client's byte pipeline cannot observe: permission blocks and
 *  interactive question cards reach the host over its HTTP agent hook, never
 *  through PTY bytes, so they must pierce the client-authority fence. */
export function hostAgentStatusPiercesClientAuthority(entry: AgentStatusEntry): boolean {
  return entry.state === 'blocked' || entry.interactivePrompt != null
}

/** True while this renderer's own byte-derived status owns the pane: it claimed
 *  the pane at transport creation and wrote status from bytes. The claim is
 *  released on pane teardown, which is how the host takes the pane back. */
export function isClientOwnedAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined
): existing is AgentStatusEntry {
  return existing !== undefined && isClientAuthoritativeAgentStatusPane(paneKey)
}

/** Owned AND still fresh — the arbitration rule for a pane the host also has an
 *  opinion about: an OSC-silent dead agent hands that contest back to the host. */
export function isFencedClientAgentStatus(
  paneKey: string,
  existing: AgentStatusEntry | undefined,
  now: number
): existing is AgentStatusEntry {
  return isClientOwnedAgentStatus(paneKey, existing) && isAgentStatusFresh(existing, now)
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

// Why: the closed-tab marker has no TTL, and setAgentStatus hard-drops writes for a
// marked tab id — for a stable mirrored id that returns, that is a permanent silent
// blackhole unless presence in a snapshot lifts it.
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

/**
 * A host retraction owes the retracted tab closeTab's renderer-state sweep: without it,
 * client-owned rows (STA-3107-exempt in the mirror's delete loop) and retention promotions
 * outlive the tab forever (STA-4593).
 */
export function buildRetractedMirroredTabSweepPatch(
  state: WebSessionTabsSyncState,
  worktreeId: string,
  nextTabsByWorktree: WebSessionTabsSyncState['tabsByWorktree'],
  agentStatusPatch: Pick<
    WebSessionTabsSyncState,
    'agentStatusByPaneKey' | 'agentStatusEpoch' | 'sortEpoch'
  > | null,
  removedTerminalResourceIds: readonly string[],
  batchContext?: WebSessionTabsBatchContext
): Partial<WebSessionTabsSyncState> | null {
  // Why: only a mirrored id the host stopped publishing is a retraction — a local or provisional
  // tab in this list is being renamed into its mirror, and a rename must keep its rows.
  const retractedTabIds = removedTerminalResourceIds.filter(isMirroredTerminalSurfaceId)
  if (retractedTabIds.length === 0) {
    return null
  }
  const sweepState: RetiredTerminalTabSweepState = {
    acknowledgedAgentsByPaneKey: state.acknowledgedAgentsByPaneKey ?? {},
    activityClearedAtByPaneKey: state.activityClearedAtByPaneKey ?? {},
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
    // Why: the drop's completed-orphan rule reads "keyed under a tab this worktree no longer has",
    // so it must see the post-removal tab list, not the one the snapshot replaced.
    tabsByWorktree: nextTabsByWorktree
  }
  // Why: a retraction can be a reconnect re-key, not pane death (ssh-execution-boundary); keeping
  // cutoffs means a republished pane cannot replay activity the user cleared on this client.
  const sweep = buildRetiredTerminalTabStateSweepPatch(sweepState, retractedTabIds, worktreeId, {
    preserveActivityClearedState: true
  })
  if (!sweep?.agentStatusByPaneKey || !batchContext) {
    return sweep ?? null
  }
  // Why: the batch republishes its own record copy at the end, which would undo the sweep.
  const mutableState = state as unknown as Record<string, unknown>
  mutableState.agentStatusByPaneKey = sweep.agentStatusByPaneKey
  batchContext.changedRecords.add('agentStatusByPaneKey')
  for (const paneKey of Object.keys(sweepState.agentStatusByPaneKey)) {
    if (!(paneKey in sweep.agentStatusByPaneKey)) {
      updateBatchAgentPaneKey(paneKey, false, batchContext)
    }
  }
  return sweep
}

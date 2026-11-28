import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { SmartSortSources } from '../../../../shared/sidebar-list/sorting/smart-sort'
import {
  buildExplicitEntriesByTabId,
  buildExplicitEntriesByWorktreeId
} from '../../../../shared/sidebar-list/sorting/smart-attention'
import {
  EMPTY_MIRRORED_TAB_IDS,
  buildMirroredTabIds,
  resolveWorktreeAttention,
  type SmartAttentionIndexes
} from '../../../../shared/sidebar-list/sorting/smart-attention-scan'

type Statuses = AppState['agentStatusByPaneKey']
type Tabs = AppState['tabsByWorktree']
type Unsupported = AppState['migrationUnsupportedByPtyId']

// Why independent WeakMaps: status ticks churn agentStatusByPaneKey without changing tabsByWorktree, so mirroredTabIds stays cached across status updates.
const mirroredTabIdsByTabs = new WeakMap<Tabs, ReadonlySet<string>>()
const attributedByStatuses = new WeakMap<Statuses, Map<string, AgentStatusEntry[]>>()
const entriesByTabIdByStatuses = new WeakMap<
  Statuses,
  WeakMap<Unsupported, Map<string, AgentStatusEntry[]>>
>()
const sharedIndexes = new WeakMap<
  Statuses,
  WeakMap<Tabs, WeakMap<Unsupported, SmartAttentionIndexes>>
>()

function getMirroredTabIds(tabsByWorktree: Tabs): ReadonlySet<string> {
  let ids = mirroredTabIdsByTabs.get(tabsByWorktree)
  if (!ids) {
    ids = buildMirroredTabIds(tabsByWorktree)
    mirroredTabIdsByTabs.set(tabsByWorktree, ids)
  }
  return ids
}

function getAttributedByWorktree(statuses: Statuses): Map<string, AgentStatusEntry[]> {
  let entries = attributedByStatuses.get(statuses)
  if (!entries) {
    entries = buildExplicitEntriesByWorktreeId(statuses)
    attributedByStatuses.set(statuses, entries)
  }
  return entries
}

function getEntriesByTabId(
  statuses: Statuses,
  unsupported: Unsupported
): Map<string, AgentStatusEntry[]> {
  let byUnsupported = entriesByTabIdByStatuses.get(statuses)
  if (!byUnsupported) {
    byUnsupported = new WeakMap()
    entriesByTabIdByStatuses.set(statuses, byUnsupported)
  }
  let entries = byUnsupported.get(unsupported)
  if (!entries) {
    entries = buildExplicitEntriesByTabId(statuses, unsupported)
    byUnsupported.set(unsupported, entries)
  }
  return entries
}

// Why shared: every bot re-ranks on the same store write, so the fleet-wide lookups are built once per input change.
function sharedIndexesFor(state: AppState): SmartAttentionIndexes {
  let byTabs = sharedIndexes.get(state.agentStatusByPaneKey)
  if (!byTabs) {
    sharedIndexes.set(state.agentStatusByPaneKey, (byTabs = new WeakMap()))
  }
  let byUnsupported = byTabs.get(state.tabsByWorktree)
  if (!byUnsupported) {
    byTabs.set(state.tabsByWorktree, (byUnsupported = new WeakMap()))
  }
  let indexes = byUnsupported.get(state.migrationUnsupportedByPtyId)
  if (!indexes) {
    const entriesByAttributedWorktreeId = getAttributedByWorktree(state.agentStatusByPaneKey)
    indexes = {
      entriesByTabId: getEntriesByTabId(
        state.agentStatusByPaneKey,
        state.migrationUnsupportedByPtyId
      ),
      entriesByAttributedWorktreeId,
      mirroredTabIds:
        entriesByAttributedWorktreeId.size > 0
          ? getMirroredTabIds(state.tabsByWorktree)
          : EMPTY_MIRRORED_TAB_IDS
    }
    byUnsupported.set(state.migrationUnsupportedByPtyId, indexes)
  }
  return indexes
}

/** The full Smart scan's sources, resolving each bot workspace against lookups shared by every bot. */
export function botSmartSortSources(state: AppState): SmartSortSources {
  return {
    tabsByWorktree: state.tabsByWorktree,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    runtimePaneTitlesByTabId: state.runtimePaneTitlesByTabId,
    ptyIdsByTabId: state.ptyIdsByTabId,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    terminalLayoutsByTabId: state.terminalLayoutsByTabId,
    attentionForWorktree: (worktree, now) =>
      resolveWorktreeAttention(worktree, sharedIndexesFor(state), state, now)
  }
}

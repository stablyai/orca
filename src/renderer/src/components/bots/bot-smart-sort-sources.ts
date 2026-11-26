import type { AppState } from '@/store/types'
import type { SmartSortSources } from '../../../../shared/sidebar-list/sorting/smart-sort'
import {
  buildSmartAttentionIndexes,
  resolveWorktreeAttention,
  type SmartAttentionIndexes
} from '../../../../shared/sidebar-list/sorting/smart-attention-scan'

type Statuses = AppState['agentStatusByPaneKey']
type Tabs = AppState['tabsByWorktree']
type Unsupported = AppState['migrationUnsupportedByPtyId']

// Why weak: an entry lives only while all three inputs are reachable, so lookups for replaced store data are collected.
const sharedIndexes = new WeakMap<
  Statuses,
  WeakMap<Tabs, WeakMap<Unsupported, SmartAttentionIndexes>>
>()

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
    indexes = buildSmartAttentionIndexes(
      state.tabsByWorktree,
      state.agentStatusByPaneKey,
      state.migrationUnsupportedByPtyId
    )
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

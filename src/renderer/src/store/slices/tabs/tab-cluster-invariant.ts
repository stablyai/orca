import type { StoreApi } from 'zustand'
import type { AppState } from '../../types'
import type { TabGroup } from '../../../../../shared/tab-types'
import { normalizeTabGroupClusters } from './tab-cluster-model'
import type { TabStripSelection } from './tabs-slice-contract'

export function normalizeTabStripSelection(
  selection: TabStripSelection | null | undefined,
  group: TabGroup | undefined,
  liveIds: ReadonlySet<string> | undefined,
  previous: TabStripSelection | undefined
): TabStripSelection | undefined {
  if (!group || !selection || !liveIds) {
    return undefined
  }
  const requested = new Set(selection.tabIds)
  const tabIds = group.tabOrder.filter((id) => requested.has(id) && liveIds.has(id))
  if (!tabIds.length) {
    return undefined
  }
  const anchorTabId =
    selection.anchorTabId &&
    liveIds.has(selection.anchorTabId) &&
    group.tabOrder.includes(selection.anchorTabId)
      ? selection.anchorTabId
      : null
  return previous &&
    tabIds.length === previous.tabIds.length &&
    tabIds.every((id, index) => id === previous.tabIds[index]) &&
    anchorTabId === previous.anchorTabId
    ? previous
    : { tabIds, anchorTabId }
}

export function installTabClusterInvariant(
  store: Pick<StoreApi<AppState>, 'getState' | 'setState' | 'subscribe'>
): () => void {
  const collectClusterPanes = (
    state: AppState
  ): Map<string, { group: TabGroup; worktreeId: string }> => {
    const panes = new Map<string, { group: TabGroup; worktreeId: string }>()
    for (const [worktreeId, groups] of Object.entries(state.groupsByWorktree)) {
      for (const group of groups) {
        if (group.tabClusters !== undefined) {
          panes.set(group.id, { group, worktreeId })
        }
      }
    }
    return panes
  }
  let clusterPanes = collectClusterPanes(store.getState())

  return store.subscribe((state, previous) => {
    if (
      state.groupsByWorktree === previous.groupsByWorktree &&
      state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree &&
      state.tabSelectionByGroupId === previous.tabSelectionByGroupId
    ) {
      return
    }

    const previousClusterPanes = clusterPanes
    if (state.groupsByWorktree !== previous.groupsByWorktree) {
      clusterPanes = collectClusterPanes(state)
    }
    let groupsByWorktree = state.groupsByWorktree
    if (!clusterPanes.size && !Object.keys(state.tabSelectionByGroupId).length) {
      return
    }
    const pinnedByWorktree = new Map<string, ReadonlySet<string>>()
    for (const { group, worktreeId } of clusterPanes.values()) {
      const previousGroup = previousClusterPanes.get(group.id)?.group
      if (
        previousGroup?.tabOrder === group.tabOrder &&
        previousGroup.tabClusters === group.tabClusters &&
        state.unifiedTabsByWorktree[worktreeId] === previous.unifiedTabsByWorktree[worktreeId]
      ) {
        continue
      }
      let pinned = pinnedByWorktree.get(worktreeId)
      if (!pinned) {
        pinned = new Set(
          (state.unifiedTabsByWorktree[worktreeId] ?? [])
            .filter((tab) => tab.isPinned)
            .map((tab) => tab.id)
        )
        pinnedByWorktree.set(worktreeId, pinned)
      }
      const normalized = normalizeTabGroupClusters(group, pinned)
      if (normalized === group) {
        continue
      }
      if (groupsByWorktree === state.groupsByWorktree) {
        groupsByWorktree = { ...groupsByWorktree }
      }
      groupsByWorktree[worktreeId] = groupsByWorktree[worktreeId].map((candidate) =>
        candidate.id === group.id ? normalized : candidate
      )
    }

    let tabSelectionByGroupId = state.tabSelectionByGroupId
    const selectedGroupIds = Object.keys(tabSelectionByGroupId)
    if (selectedGroupIds.length) {
      const panes = new Map<string, { group: TabGroup; liveIds: ReadonlySet<string> }>()
      const requestedPanes = new Set(selectedGroupIds)
      for (const [worktreeId, groups] of Object.entries(groupsByWorktree)) {
        for (const group of groups) {
          if (!requestedPanes.has(group.id)) {
            continue
          }
          panes.set(group.id, {
            group,
            liveIds: new Set(
              (state.unifiedTabsByWorktree[worktreeId] ?? [])
                .filter((tab) => tab.groupId === group.id)
                .map((tab) => tab.id)
            )
          })
        }
      }
      for (const groupId of selectedGroupIds) {
        const previousSelection = state.tabSelectionByGroupId[groupId]
        const pane = panes.get(groupId)
        const selection = normalizeTabStripSelection(
          previousSelection,
          pane?.group,
          pane?.liveIds,
          previousSelection
        )
        if (selection === previousSelection) {
          continue
        }
        if (tabSelectionByGroupId === state.tabSelectionByGroupId) {
          tabSelectionByGroupId = { ...tabSelectionByGroupId }
        }
        if (selection) {
          tabSelectionByGroupId[groupId] = selection
        } else {
          delete tabSelectionByGroupId[groupId]
        }
      }
    }
    if (
      groupsByWorktree === state.groupsByWorktree &&
      tabSelectionByGroupId === state.tabSelectionByGroupId
    ) {
      return
    }
    store.setState({ groupsByWorktree, tabSelectionByGroupId })
  })
}

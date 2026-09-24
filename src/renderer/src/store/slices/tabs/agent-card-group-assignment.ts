import type { Tab, TabGroup } from '../../../../../shared/tab-types'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { collectLayoutLeafGroupIds } from './agent-cards-projection'
import type { TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'

/** Every carding move is silent: no worktree-focus activation, no feature-interaction recording. */
export const SILENT_MOVE_OPTS = { activate: false, recordInteraction: false }

/** A minted card group's activeTabId starts null; this sets only that group's own active tab. */
export const TILE_MINT_MOVE_OPTS = {
  activate: false,
  activateInTargetGroup: true,
  recordInteraction: false
}

export function createAgentCardGroup(
  set: TabsSliceSet,
  worktreeId: string,
  opts?: { activate?: boolean }
): string {
  const newGroupId = createBrowserUuid()
  const newGroup: TabGroup = {
    id: newGroupId,
    worktreeId,
    activeTabId: null,
    tabOrder: [],
    recentTabIds: []
  }
  const shouldActivate = opts?.activate !== false
  set((state) => ({
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: [...(state.groupsByWorktree[worktreeId] ?? []), newGroup]
    },
    // Why (N1): register in the same update that mints the group, so the registry can
    // never lag behind a group that already exists off-layout (e.g. no surface mounted yet).
    agentCardGroupIdsByWorktree: {
      ...state.agentCardGroupIdsByWorktree,
      [worktreeId]: [...(state.agentCardGroupIdsByWorktree[worktreeId] ?? []), newGroupId]
    },
    ...(shouldActivate
      ? {
          activeGroupIdByWorktree: {
            ...state.activeGroupIdByWorktree,
            [worktreeId]: newGroupId
          }
        }
      : {})
  }))
  return newGroupId
}

/** Undoes createAgentCardGroup for a group that never received its tab. */
function removeAgentCardGroup(set: TabsSliceSet, worktreeId: string, groupId: string): void {
  set((state) => ({
    groupsByWorktree: {
      ...state.groupsByWorktree,
      [worktreeId]: (state.groupsByWorktree[worktreeId] ?? []).filter(
        (group) => group.id !== groupId
      )
    },
    agentCardGroupIdsByWorktree: {
      ...state.agentCardGroupIdsByWorktree,
      [worktreeId]: (state.agentCardGroupIdsByWorktree[worktreeId] ?? []).filter(
        (id) => id !== groupId
      )
    }
  }))
}

export function assignAgentCardGroups(
  get: TabsSliceGet,
  set: TabsSliceSet,
  worktreeId: string,
  headTabs: readonly Tab[]
): string[] {
  const leafIds = collectLayoutLeafGroupIds(get().layoutByWorktree[worktreeId])
  const cardGroupIds: string[] = []
  for (const tab of headTabs) {
    const group = (get().groupsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.id === tab.groupId
    )
    const isAloneInOwnGroup = group?.tabOrder.length === 1 && group.tabOrder[0] === tab.id
    if (isAloneInOwnGroup && !leafIds.has(tab.groupId)) {
      cardGroupIds.push(tab.groupId)
      continue
    }
    const cardGroupId = createAgentCardGroup(set, worktreeId, { activate: false })
    if (!get().moveUnifiedTabToGroup(tab.id, cardGroupId, TILE_MINT_MOVE_OPTS)) {
      // Why roll back: the id never reaches the returned list, so no later prune can reach it.
      removeAgentCardGroup(set, worktreeId, cardGroupId)
      continue
    }
    cardGroupIds.push(cardGroupId)
  }
  return cardGroupIds
}

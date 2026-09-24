import {
  AGENT_CARDS_MAX,
  isAgentOnlyGroup,
  selectAgentTabs,
  selectAgentsTab
} from './agent-card-tabs'
import { assignAgentCardGroups, createAgentCardGroup } from './agent-card-group-assignment'
import {
  collectLayoutLeafGroupIds,
  projectAgentCardsToOrdinaryTabs
} from './agent-cards-projection'
import { ensureAgentsTab, resolveAgentsTabHomeGroupId } from './agents-tab-placement'
import type { TabsSlice, TabsSliceGet, TabsSliceSet } from './tabs-slice-contract'

function withoutWorktreeKey<T>(map: Record<string, T>, worktreeId: string): Record<string, T> {
  if (!(worktreeId in map)) {
    return map
  }
  const { [worktreeId]: _removed, ...rest } = map
  return rest
}

function sameIdOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index])
}

function pruneEmptyCardGroups(
  set: TabsSliceSet,
  worktreeId: string,
  cardGroupIds: readonly string[]
): void {
  const cardIdSet = new Set(cardGroupIds)
  set((state) => {
    const groups = state.groupsByWorktree[worktreeId] ?? []
    const nextGroups = groups.filter(
      (group) => !cardIdSet.has(group.id) || group.tabOrder.length > 0
    )
    if (nextGroups.length === groups.length) {
      return state
    }
    return {
      groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: nextGroups }
    }
  })
}

export function createTabsAgentCardsActions(
  set: TabsSliceSet,
  get: TabsSliceGet
): Pick<
  TabsSlice,
  | 'resolveAgentLaunchGroupId'
  | 'syncAgentCards'
  | 'restoreAgentCardsAsTabs'
  | 'focusAgentCardByIndex'
  | 'toggleMaximizedAgentCard'
> {
  return {
    resolveAgentLaunchGroupId: (worktreeId, callerGroupId) => {
      if (get().settings?.experimentalTiledAgents !== true) {
        return callerGroupId
      }
      const agentTabs = selectAgentTabs(
        get().unifiedTabsByWorktree[worktreeId] ?? [],
        get().tabsByWorktree[worktreeId] ?? []
      )
      if (agentTabs.length >= AGENT_CARDS_MAX) {
        return callerGroupId
      }
      const homeGroupId =
        selectAgentsTab(get().unifiedTabsByWorktree[worktreeId] ?? [])?.groupId ??
        callerGroupId ??
        get().activeGroupIdByWorktree[worktreeId] ??
        get().ensureWorktreeRootGroup(worktreeId)
      ensureAgentsTab(get, worktreeId, homeGroupId)
      const agentsTab = selectAgentsTab(get().unifiedTabsByWorktree[worktreeId] ?? [])
      if (agentsTab) {
        get().activateTab(agentsTab.id, { worktreeId })
      }
      return createAgentCardGroup(set, worktreeId, { activate: false })
    },

    syncAgentCards: (worktreeId) => {
      const enabled = get().settings?.experimentalTiledAgents === true
      if (!enabled) {
        if (
          selectAgentsTab(get().unifiedTabsByWorktree[worktreeId] ?? []) ||
          (get().agentCardGroupIdsByWorktree[worktreeId] ?? []).length > 0
        ) {
          get().restoreAgentCardsAsTabs(worktreeId)
        }
        return { carded: false, overflowTabIds: [] }
      }

      const agentTabs = selectAgentTabs(
        get().unifiedTabsByWorktree[worktreeId] ?? [],
        get().tabsByWorktree[worktreeId] ?? []
      )
      if (agentTabs.length === 0) {
        const extras = (get().unifiedTabsByWorktree[worktreeId] ?? []).filter(
          (tab) => tab.contentType === 'agents'
        )
        for (const tab of extras) {
          get().closeUnifiedTab(tab.id, {
            preserveWorktreeSelection: true,
            recordInteraction: false
          })
        }
        const leftoverCardIds = get().agentCardGroupIdsByWorktree[worktreeId] ?? []
        if (leftoverCardIds.length > 0) {
          pruneEmptyCardGroups(set, worktreeId, leftoverCardIds)
        }
        set((state) => ({
          agentCardGroupIdsByWorktree: withoutWorktreeKey(
            state.agentCardGroupIdsByWorktree,
            worktreeId
          ),
          maximizedGroupIdByWorktree: withoutWorktreeKey(
            state.maximizedGroupIdByWorktree,
            worktreeId
          )
        }))
        return { carded: false, overflowTabIds: [] }
      }

      ensureAgentsTab(
        get,
        worktreeId,
        resolveAgentsTabHomeGroupId(get, worktreeId, agentTabs[0].groupId)
      )

      const extras = (get().unifiedTabsByWorktree[worktreeId] ?? []).filter(
        (tab) => tab.contentType === 'agents'
      )
      for (const extra of extras.slice(1)) {
        get().closeUnifiedTab(extra.id, {
          preserveWorktreeSelection: true,
          recordInteraction: false
        })
      }

      const head = agentTabs.slice(0, AGENT_CARDS_MAX)
      const overflow = agentTabs.slice(AGENT_CARDS_MAX)
      const previousIds = get().agentCardGroupIdsByWorktree[worktreeId] ?? []
      const cardGroupIds = assignAgentCardGroups(get, set, worktreeId, head)
      const leafIds = collectLayoutLeafGroupIds(get().layoutByWorktree[worktreeId])
      const agentTabIds = new Set(agentTabs.map((tab) => tab.id))
      // Why (N1 self-heal): a group that already looks like a card group (off-layout, holds
      // only agent tabs) but missed the registry write should be adopted here, not left to
      // persist as an ordinary group and split into its own layout column next hydration.
      const unregisteredCardGroupIds = (get().groupsByWorktree[worktreeId] ?? [])
        .filter(
          (group) =>
            !leafIds.has(group.id) &&
            !cardGroupIds.includes(group.id) &&
            group.tabOrder.length > 0 &&
            isAgentOnlyGroup(group.tabOrder, agentTabIds)
        )
        .map((group) => group.id)
      const nextCardGroupIds = [...cardGroupIds, ...unregisteredCardGroupIds]
      pruneEmptyCardGroups(set, worktreeId, [...new Set([...previousIds, ...nextCardGroupIds])])
      const maximizedId = get().maximizedGroupIdByWorktree[worktreeId]
      const maximizeStale = maximizedId !== undefined && !nextCardGroupIds.includes(maximizedId)
      if (!sameIdOrder(previousIds, nextCardGroupIds) || maximizeStale) {
        set((state) => ({
          ...(!sameIdOrder(previousIds, nextCardGroupIds)
            ? {
                agentCardGroupIdsByWorktree: {
                  ...state.agentCardGroupIdsByWorktree,
                  [worktreeId]: nextCardGroupIds
                }
              }
            : {}),
          ...(maximizeStale
            ? {
                maximizedGroupIdByWorktree: withoutWorktreeKey(
                  state.maximizedGroupIdByWorktree,
                  worktreeId
                )
              }
            : {})
        }))
      }

      return { carded: true, overflowTabIds: overflow.map((tab) => tab.id) }
    },

    restoreAgentCardsAsTabs: (worktreeId) => {
      const tabs = get().unifiedTabsByWorktree[worktreeId] ?? []
      const groups = get().groupsByWorktree[worktreeId] ?? []
      const layout = get().layoutByWorktree[worktreeId]
      const cardGroupIds = get().agentCardGroupIdsByWorktree[worktreeId] ?? []
      const terminalTabs = get().tabsByWorktree[worktreeId] ?? []
      const projected = projectAgentCardsToOrdinaryTabs({
        tabs,
        groups,
        layout,
        cardGroupIds,
        terminalTabs
      })
      if (projected.tabs === tabs && projected.groups === groups) {
        // Why: with no layout the projection is a deliberate no-op, not "nothing to restore",
        // so dropping the registry here would leave live card groups off-layout and untracked.
        if (layout === undefined && cardGroupIds.length > 0) {
          return false
        }
        set((state) => ({
          agentCardGroupIdsByWorktree: withoutWorktreeKey(
            state.agentCardGroupIdsByWorktree,
            worktreeId
          ),
          maximizedGroupIdByWorktree: withoutWorktreeKey(
            state.maximizedGroupIdByWorktree,
            worktreeId
          )
        }))
        return false
      }
      const homeGroupId = projected.groups[0]?.id
      const activeGroupId = get().activeGroupIdByWorktree[worktreeId]
      const nextGroups = projected.groups
      const nextActiveGroupId =
        activeGroupId && nextGroups.some((group) => group.id === activeGroupId)
          ? activeGroupId
          : (homeGroupId ?? activeGroupId)
      set((state) => ({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: [...projected.tabs]
        },
        groupsByWorktree: { ...state.groupsByWorktree, [worktreeId]: [...projected.groups] },
        agentCardGroupIdsByWorktree: withoutWorktreeKey(
          state.agentCardGroupIdsByWorktree,
          worktreeId
        ),
        maximizedGroupIdByWorktree: withoutWorktreeKey(
          state.maximizedGroupIdByWorktree,
          worktreeId
        ),
        ...(nextActiveGroupId && nextActiveGroupId !== activeGroupId
          ? {
              activeGroupIdByWorktree: {
                ...state.activeGroupIdByWorktree,
                [worktreeId]: nextActiveGroupId
              }
            }
          : {})
      }))
      return true
    },

    focusAgentCardByIndex: (worktreeId, index) => {
      const cardGroupId = (get().agentCardGroupIdsByWorktree[worktreeId] ?? [])[index]
      if (!cardGroupId) {
        return false
      }
      const agentsTab = selectAgentsTab(get().unifiedTabsByWorktree[worktreeId] ?? [])
      if (agentsTab) {
        get().activateTab(agentsTab.id, { worktreeId })
      }
      get().focusGroup(worktreeId, cardGroupId)
      const group = (get().groupsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.id === cardGroupId
      )
      if (group?.activeTabId) {
        get().activateTab(group.activeTabId, { worktreeId })
      }
      if (worktreeId in get().maximizedGroupIdByWorktree) {
        set((state) => ({
          maximizedGroupIdByWorktree: withoutWorktreeKey(
            state.maximizedGroupIdByWorktree,
            worktreeId
          )
        }))
      }
      return true
    },

    toggleMaximizedAgentCard: (worktreeId, cardGroupId) => {
      if (get().settings?.experimentalTiledAgents !== true) {
        return null
      }
      const cardGroupIds = get().agentCardGroupIdsByWorktree[worktreeId] ?? []
      if (cardGroupIds.length < 2) {
        return null
      }
      const targetGroupId = cardGroupId ?? get().activeGroupIdByWorktree[worktreeId]
      if (!targetGroupId || !cardGroupIds.includes(targetGroupId)) {
        return null
      }
      let nextValue: string | null = null
      set((state) => {
        const isMaximized = state.maximizedGroupIdByWorktree[worktreeId] === targetGroupId
        nextValue = isMaximized ? null : targetGroupId
        return {
          maximizedGroupIdByWorktree: isMaximized
            ? withoutWorktreeKey(state.maximizedGroupIdByWorktree, worktreeId)
            : { ...state.maximizedGroupIdByWorktree, [worktreeId]: targetGroupId }
        }
      })
      return nextValue
    }
  }
}

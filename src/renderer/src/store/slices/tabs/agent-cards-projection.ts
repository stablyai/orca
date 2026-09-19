import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { isAgentOnlyGroup, selectAgentTabs, selectAgentsTab } from './agent-card-tabs'

export function collectLayoutLeafGroupIds(root: TabGroupLayoutNode | undefined): Set<string> {
  if (!root) {
    return new Set()
  }
  if (root.type === 'leaf') {
    return new Set([root.groupId])
  }
  return new Set([
    ...collectLayoutLeafGroupIds(root.first),
    ...collectLayoutLeafGroupIds(root.second)
  ])
}

/** Flattens agent cards back to ordinary tabs: every carded agent tab returns to the Agents
 *  tab's home group in card order, the Agents tab is dropped, card groups are dropped.
 *  Pure. Used by the session payload builder and by restoreAgentCardsAsTabs. */
export function projectAgentCardsToOrdinaryTabs(input: {
  tabs: readonly Tab[]
  groups: readonly TabGroup[]
  layout: TabGroupLayoutNode | undefined
  cardGroupIds: readonly string[]
  // Why optional: callers without a terminal-tab view (e.g. hand-built session fixtures) get none.
  terminalTabs?: readonly TerminalTab[]
}): { tabs: readonly Tab[]; groups: readonly TabGroup[]; layout: TabGroupLayoutNode | undefined } {
  // Why: a missing layout is not "every group is a card group" (legitimate off-layout groups
  // exist); belt-and-braces alongside the registry intersect below.
  if (input.layout === undefined) {
    return { tabs: input.tabs, groups: input.groups, layout: input.layout }
  }
  const agentsTab = selectAgentsTab(input.tabs)
  const leafIds = collectLayoutLeafGroupIds(input.layout)
  const registry = new Set(input.cardGroupIds)
  const agentTabIds = new Set(
    selectAgentTabs(input.tabs, input.terminalTabs ?? []).map((tab) => tab.id)
  )
  // Why: "not in the layout" and "in the registry" are each necessary but not sufficient -
  // also require the group to actually hold only agent tabs (N1), so neither a legitimately
  // off-layout group nor a registered id that outlived its content is misclassified.
  const cardGroups = input.groups.filter(
    (group) =>
      registry.has(group.id) &&
      !leafIds.has(group.id) &&
      isAgentOnlyGroup(group.tabOrder, agentTabIds)
  )
  if (!agentsTab && cardGroups.length === 0) {
    return {
      tabs: input.tabs,
      groups: input.groups,
      layout: input.layout
    }
  }

  const cardGroupIds = new Set(cardGroups.map((group) => group.id))
  const firstLeafId = [...leafIds][0]
  const homeGroupId = agentsTab?.groupId ?? firstLeafId ?? input.groups[0]?.id
  if (!homeGroupId) {
    return {
      tabs: input.tabs.filter((tab) => tab.contentType !== 'agents'),
      groups: input.groups,
      layout: input.layout
    }
  }

  const cardedTabs: Tab[] = []
  for (const group of cardGroups) {
    for (const tabId of group.tabOrder) {
      const tab = input.tabs.find((candidate) => candidate.id === tabId)
      if (tab && tab.contentType !== 'agents') {
        cardedTabs.push({ ...tab, groupId: homeGroupId })
      }
    }
  }

  const remainingTabs = input.tabs.filter(
    (tab) => tab.contentType !== 'agents' && !cardGroupIds.has(tab.groupId)
  )
  const tabs = [...remainingTabs, ...cardedTabs]
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const groups = input.groups
    .filter((group) => !cardGroupIds.has(group.id))
    .map((group) => {
      if (group.id !== homeGroupId) {
        return group
      }
      const existingOrder = group.tabOrder.filter(
        (tabId) => tabIds.has(tabId) && tabId !== agentsTab?.id
      )
      const cardedIds = cardedTabs
        .map((tab) => tab.id)
        .filter((tabId) => !existingOrder.includes(tabId))
      const tabOrder = [...existingOrder, ...cardedIds]
      return {
        ...group,
        tabOrder,
        activeTabId:
          group.activeTabId &&
          group.activeTabId !== agentsTab?.id &&
          tabOrder.includes(group.activeTabId)
            ? group.activeTabId
            : (tabOrder.at(-1) ?? null),
        recentTabIds: group.recentTabIds?.filter(
          (tabId) => tabId !== agentsTab?.id && tabOrder.includes(tabId)
        )
      }
    })

  return { tabs, groups, layout: input.layout }
}

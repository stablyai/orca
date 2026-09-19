import { translate } from '@/i18n/i18n'
import type { Tab } from '../../../../../shared/tab-types'
import { selectAgentsTab } from './agent-card-tabs'
import { collectLayoutLeafGroupIds } from './agent-cards-projection'
import type { TabsSliceGet } from './tabs-slice-contract'

/**
 * The group the Agents tab should live in: one the layout actually renders.
 *
 * Why this is not simply an agent tab's group: once the agents are carded, every agent tab lives
 * in a card group, and card groups are deliberately absent from the layout. Recreating the Agents
 * tab there, which is what happens right after the user closes it, would put it in a group nothing
 * renders, leaving every agent unreachable.
 */
export function resolveAgentsTabHomeGroupId(
  get: TabsSliceGet,
  worktreeId: string,
  fallbackGroupId: string
): string {
  const existingGroupId = selectAgentsTab(get().unifiedTabsByWorktree[worktreeId] ?? [])?.groupId
  if (existingGroupId !== undefined) {
    return existingGroupId
  }
  const layoutLeafIds = collectLayoutLeafGroupIds(get().layoutByWorktree[worktreeId])
  const cardGroupIds = new Set(get().agentCardGroupIdsByWorktree[worktreeId] ?? [])
  const rendered = (get().groupsByWorktree[worktreeId] ?? []).find(
    (group) => layoutLeafIds.has(group.id) && !cardGroupIds.has(group.id)
  )
  return rendered?.id ?? fallbackGroupId
}

/** The worktree's single pinned Agents tab, created in `homeGroupId` when it does not exist yet. */
export function ensureAgentsTab(get: TabsSliceGet, worktreeId: string, homeGroupId: string): Tab {
  const existing = selectAgentsTab(get().unifiedTabsByWorktree[worktreeId] ?? [])
  if (existing) {
    return existing
  }
  return get().createUnifiedTab(worktreeId, 'agents', {
    entityId: `agents:${worktreeId}`,
    label: translate('auto.components.tab.group.AgentsTab.label', 'Agents'),
    isPinned: true,
    targetGroupId: homeGroupId
  })
}

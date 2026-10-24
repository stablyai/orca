import type { AppState } from '@/store/types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TabGroupLayoutNode } from '../../../shared/tab-types'
import { collectTabGroupLayoutGroupIds } from '../../../shared/workspace-layout/tab-group-moves'
import { getCachedUnifiedTerminalTabCandidates } from '@/components/terminal-pane/terminal-unified-tab-lookup'
import { projectGroupedTerminalTab, resolveTerminalItemTab } from './terminal-tab-item-projection'

const groupRanks = new WeakMap<TabGroupLayoutNode, ReadonlyMap<string, number>>()

function ranksFor(layout: TabGroupLayoutNode): ReadonlyMap<string, number> {
  let ranks = groupRanks.get(layout)
  if (!ranks) {
    ranks = new Map([...collectTabGroupLayoutGroupIds(layout)].map((id, index) => [id, index]))
    groupRanks.set(layout, ranks)
  }
  return ranks
}

export type TerminalAgentEvidenceScope = { key: string; title: string }
export function terminalAgentEvidenceScopeKey(
  worktreeId: string,
  tabId: string,
  groupId?: string
): string {
  return JSON.stringify([worktreeId, groupId ?? null, tabId])
}

export function terminalAgentEvidenceScopes(
  state: AppState,
  tab: TerminalTab
): readonly TerminalAgentEvidenceScope[] {
  const enabled = state.settings?.tabAutoGenerateTitle === true
  const layout = state.layoutByWorktree[tab.worktreeId]
  const fallbackGroup =
    state.activeGroupIdByWorktree[tab.worktreeId] ?? state.groupsByWorktree[tab.worktreeId]?.[0]?.id
  const ranks = layout ? ranksFor(layout) : null
  const candidates = getCachedUnifiedTerminalTabCandidates(
    state.unifiedTabsByWorktree,
    tab.worktreeId,
    tab.id
  )
  const byGroup = new Map<string, (typeof candidates)[number]>()
  for (const candidate of candidates) {
    if (ranks ? ranks.has(candidate.groupId) : candidate.groupId === fallbackGroup) {
      byGroup.set(candidate.groupId, candidate)
    }
  }
  if (byGroup.size === 0) {
    return [
      {
        key: terminalAgentEvidenceScopeKey(tab.worktreeId, tab.id),
        title: resolveTerminalItemTab(tab, enabled).title
      }
    ]
  }
  return [...byGroup.values()]
    .sort((left, right) => (ranks?.get(left.groupId) ?? 0) - (ranks?.get(right.groupId) ?? 0))
    .map((item) => ({
      key: terminalAgentEvidenceScopeKey(tab.worktreeId, tab.id, item.groupId),
      title: resolveTerminalItemTab(
        projectGroupedTerminalTab(item, tab, tab.worktreeId, enabled),
        enabled
      ).title
    }))
}

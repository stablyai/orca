import type { RuntimeTerminalOrphanTopology } from '../../../shared/runtime-types'
import type {
  TabGroup,
  TabGroupLayoutNode,
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../../../shared/types'
import { toHostSessionTabId } from './web-terminal-surface-id'

export type WebTerminalOrphanTopologyState = {
  terminalLayoutsByTabId: Record<string, TerminalLayoutSnapshot>
  activeTabIdByWorktree: Record<string, string | null | undefined>
  activeGroupIdByWorktree: Record<string, string | null | undefined>
  groupsByWorktree?: Record<string, TabGroup[] | undefined>
  layoutByWorktree?: Record<string, TabGroupLayoutNode | undefined>
}

function prunePaneLayout(
  node: TerminalPaneLayoutNode | null,
  retainedLeafIds: ReadonlySet<string>
): TerminalPaneLayoutNode | null {
  if (!node) {
    return null
  }
  if (node.type === 'leaf') {
    return retainedLeafIds.has(node.leafId) ? node : null
  }
  const first = prunePaneLayout(node.first, retainedLeafIds)
  const second = prunePaneLayout(node.second, retainedLeafIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

function pruneGroupLayout(
  node: TabGroupLayoutNode | undefined,
  retainedGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return retainedGroupIds.has(node.groupId) ? node : undefined
  }
  const first = pruneGroupLayout(node.first, retainedGroupIds)
  const second = pruneGroupLayout(node.second, retainedGroupIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

export function buildWebTerminalOrphanTopologyProposal(
  state: WebTerminalOrphanTopologyState,
  worktreeId: string,
  candidates: readonly TerminalTab[],
  claims: readonly { tabId: string; leafId: string }[]
): RuntimeTerminalOrphanTopology | undefined {
  const leafIdsByTabId = new Map<string, Set<string>>()
  for (const claim of claims) {
    const leafIds = leafIdsByTabId.get(claim.tabId) ?? new Set<string>()
    leafIds.add(claim.leafId)
    leafIdsByTabId.set(claim.tabId, leafIds)
  }
  const hostTabIdByLocalId = new Map(
    candidates.map((tab) => [tab.id, toHostSessionTabId(tab.id)] as const)
  )
  const tabs = candidates.flatMap((tab) => {
    const tabId = hostTabIdByLocalId.get(tab.id)!
    const retainedLeafIds = leafIdsByTabId.get(tabId)
    const layout = state.terminalLayoutsByTabId[tab.id]
    const root = retainedLeafIds ? prunePaneLayout(layout?.root ?? null, retainedLeafIds) : null
    if (!layout || !root || !retainedLeafIds || retainedLeafIds.size === 0) {
      return []
    }
    const fallbackLeafId = [...retainedLeafIds][0]!
    return [
      {
        tabId,
        root,
        activeLeafId: retainedLeafIds.has(layout.activeLeafId ?? '')
          ? layout.activeLeafId!
          : fallbackLeafId,
        expandedLeafId:
          layout.expandedLeafId && retainedLeafIds.has(layout.expandedLeafId)
            ? layout.expandedLeafId
            : null
      }
    ]
  })
  if (tabs.length !== leafIdsByTabId.size) {
    return undefined
  }

  const adoptedTabIds = new Set(tabs.map((tab) => tab.tabId))
  const groups = (state.groupsByWorktree?.[worktreeId] ?? []).flatMap((group) => {
    const tabOrder = group.tabOrder
      .map((tabId) => hostTabIdByLocalId.get(tabId))
      .filter((tabId): tabId is string => Boolean(tabId && adoptedTabIds.has(tabId)))
    if (tabOrder.length === 0) {
      return []
    }
    const requestedActive = group.activeTabId
      ? hostTabIdByLocalId.get(group.activeTabId)
      : undefined
    const recentTabIds = group.recentTabIds
      ?.map((tabId) => hostTabIdByLocalId.get(tabId))
      .filter((tabId): tabId is string => Boolean(tabId && tabOrder.includes(tabId)))
    return [
      {
        id: group.id,
        activeTabId:
          requestedActive && tabOrder.includes(requestedActive) ? requestedActive : tabOrder[0]!,
        tabOrder,
        ...(recentTabIds && recentTabIds.length > 0 ? { recentTabIds } : {})
      }
    ]
  })
  const completeGroups =
    groups.length > 0
      ? groups
      : [
          {
            id: state.activeGroupIdByWorktree[worktreeId] ?? 'recovered-orphans',
            activeTabId: tabs[0]!.tabId,
            tabOrder: tabs.map((tab) => tab.tabId)
          }
        ]
  const groupIds = new Set(completeGroups.map((group) => group.id))
  const groupLayout = pruneGroupLayout(state.layoutByWorktree?.[worktreeId], groupIds)
  return { tabs, groups: completeGroups, ...(groupLayout ? { groupLayout } : {}) }
}

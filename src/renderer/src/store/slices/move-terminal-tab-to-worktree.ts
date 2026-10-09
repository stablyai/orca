import type { Tab, TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { RetainedAgentEntry } from './agent-status'
import { ensureGroup, sanitizeRecentTabIds } from './tab-group-state'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

export type TerminalTabMoveStoreState = {
  tabsByWorktree: Record<string, TerminalTab[]>
  unifiedTabsByWorktree: Record<string, Tab[]>
  groupsByWorktree: Record<string, TabGroup[]>
  layoutByWorktree: Record<string, TabGroupLayoutNode>
  activeGroupIdByWorktree: Record<string, string>
  tabBarOrderByWorktree: Record<string, string[]>
  activeTabIdByWorktree: Record<string, string | null>
  activeTabId: string | null
  agentStatusByPaneKey: Record<string, AgentStatusEntry>
  retainedAgentsByPaneKey: Record<string, RetainedAgentEntry>
  sleepingAgentSessionsByPaneKey: Record<string, SleepingAgentSessionRecord>
}

export type TerminalTabMoveStoreResult = {
  patch: Partial<TerminalTabMoveStoreState>
  sourceWorktreeId: string
  destWorktreeId: string
  tabId: string
}

function pruneGroupLayout(
  node: TabGroupLayoutNode | undefined,
  validGroupIds: ReadonlySet<string>
): TabGroupLayoutNode | undefined {
  if (!node) {
    return undefined
  }
  if (node.type === 'leaf') {
    return validGroupIds.has(node.groupId) ? node : undefined
  }
  const first = pruneGroupLayout(node.first, validGroupIds)
  const second = pruneGroupLayout(node.second, validGroupIds)
  if (!first) {
    return second
  }
  if (!second) {
    return first
  }
  return { ...node, first, second }
}

function remintRetainedWorktreeId(
  records: Record<string, RetainedAgentEntry>,
  tabId: string,
  destWorktreeId: string
): Record<string, RetainedAgentEntry> {
  let changed = false
  const next: Record<string, RetainedAgentEntry> = {}
  for (const [key, record] of Object.entries(records)) {
    const paneTabId = parsePaneKey(key)?.tabId
    if (paneTabId === tabId || record.tab.id === tabId) {
      next[key] = {
        ...record,
        worktreeId: destWorktreeId,
        tab: { ...record.tab, worktreeId: destWorktreeId }
      }
      changed = true
    } else {
      next[key] = record
    }
  }
  return changed ? next : records
}

function remintWorktreeId<T extends { worktreeId?: string; tabId?: string | null }>(
  records: Record<string, T>,
  tabId: string,
  destWorktreeId: string
): Record<string, T> {
  let changed = false
  const next: Record<string, T> = {}
  for (const [key, record] of Object.entries(records)) {
    const paneTabId = parsePaneKey(key)?.tabId
    if (paneTabId === tabId || record.tabId === tabId) {
      next[key] = { ...record, worktreeId: destWorktreeId }
      changed = true
    } else {
      next[key] = record
    }
  }
  return changed ? next : records
}

export function findTerminalTabWorktreeId(
  tabsByWorktree: Record<string, TerminalTab[]>,
  tabId: string
): string | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === tabId)) {
      return worktreeId
    }
  }
  return null
}

export function moveTerminalTabToWorktreeInStore(
  state: TerminalTabMoveStoreState,
  tabId: string,
  destWorktreeId: string
): TerminalTabMoveStoreResult | null {
  const sourceWorktreeId = findTerminalTabWorktreeId(state.tabsByWorktree, tabId)
  if (!sourceWorktreeId || sourceWorktreeId === destWorktreeId) {
    return null
  }
  const terminalRow = (state.tabsByWorktree[sourceWorktreeId] ?? []).find((tab) => tab.id === tabId)
  if (!terminalRow) {
    return null
  }
  const sourceUnified = state.unifiedTabsByWorktree[sourceWorktreeId] ?? []
  const movingUnified = sourceUnified.filter(
    (tab) => tab.contentType === 'terminal' && (tab.entityId === tabId || tab.id === tabId)
  )
  const movingUnifiedIds = new Set(movingUnified.map((tab) => tab.id))
  movingUnifiedIds.add(tabId)

  const destEnsured = ensureGroup(
    state.groupsByWorktree,
    state.activeGroupIdByWorktree,
    destWorktreeId,
    state.activeGroupIdByWorktree[destWorktreeId]
  )
  const destGroup = destEnsured.group
  const destUnifiedExisting = state.unifiedTabsByWorktree[destWorktreeId] ?? []
  const destUnifiedIds = new Set(destUnifiedExisting.map((tab) => tab.id))
  const movedUnified = movingUnified
    .filter((tab) => !destUnifiedIds.has(tab.id))
    .map((tab) => ({ ...tab, worktreeId: destWorktreeId, groupId: destGroup.id }))
  const destTabOrder = [
    ...destGroup.tabOrder.filter((id) => !movingUnifiedIds.has(id)),
    ...movedUnified.map((tab) => tab.id)
  ]
  const destGroups = (destEnsured.groupsByWorktree[destWorktreeId] ?? []).map((group) =>
    group.id === destGroup.id
      ? {
          ...group,
          worktreeId: destWorktreeId,
          tabOrder: destTabOrder,
          activeTabId: movedUnified.at(-1)?.id ?? destGroup.activeTabId,
          recentTabIds: [
            ...sanitizeRecentTabIds(destGroup.recentTabIds, destTabOrder).filter(
              (id) => !movingUnifiedIds.has(id)
            ),
            ...movedUnified.map((tab) => tab.id)
          ]
        }
      : group
  )

  const sourceGroups = (state.groupsByWorktree[sourceWorktreeId] ?? [])
    .map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !movingUnifiedIds.has(id))
      const activeTabId = movingUnifiedIds.has(group.activeTabId ?? '')
        ? (tabOrder[0] ?? null)
        : group.activeTabId && tabOrder.includes(group.activeTabId)
          ? group.activeTabId
          : (tabOrder[0] ?? null)
      return {
        ...group,
        tabOrder,
        activeTabId,
        recentTabIds: sanitizeRecentTabIds(group.recentTabIds, tabOrder)
      }
    })
    .filter((group) => group.tabOrder.length > 0)
  const validSourceGroupIds = new Set(sourceGroups.map((group) => group.id))
  const sourceLayout = pruneGroupLayout(state.layoutByWorktree[sourceWorktreeId], validSourceGroupIds)
  const nextLayoutByWorktree = { ...state.layoutByWorktree }
  if (sourceLayout) {
    nextLayoutByWorktree[sourceWorktreeId] = sourceLayout
  } else {
    delete nextLayoutByWorktree[sourceWorktreeId]
  }
  if (!nextLayoutByWorktree[destWorktreeId]) {
    nextLayoutByWorktree[destWorktreeId] = { type: 'leaf', groupId: destGroup.id }
  }

  const sourceTerminals = (state.tabsByWorktree[sourceWorktreeId] ?? []).filter(
    (tab) => tab.id !== tabId
  )
  const destTerminals = [
    ...(state.tabsByWorktree[destWorktreeId] ?? []).filter((tab) => tab.id !== tabId),
    { ...terminalRow, worktreeId: destWorktreeId }
  ]

  const sourceBar = (state.tabBarOrderByWorktree[sourceWorktreeId] ?? []).filter((id) => id !== tabId)
  const destBar = [
    ...(state.tabBarOrderByWorktree[destWorktreeId] ?? []).filter((id) => id !== tabId),
    tabId
  ]

  const nextActiveGroupIdByWorktree = {
    ...destEnsured.activeGroupIdByWorktree,
    [destWorktreeId]: destGroup.id
  }
  const sourceActiveGroupId = validSourceGroupIds.has(
    state.activeGroupIdByWorktree[sourceWorktreeId] ?? ''
  )
    ? state.activeGroupIdByWorktree[sourceWorktreeId]
    : sourceGroups[0]?.id
  if (sourceActiveGroupId) {
    nextActiveGroupIdByWorktree[sourceWorktreeId] = sourceActiveGroupId
  } else {
    delete nextActiveGroupIdByWorktree[sourceWorktreeId]
  }

  return {
    sourceWorktreeId,
    destWorktreeId,
    tabId,
    patch: {
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [sourceWorktreeId]: sourceTerminals,
        [destWorktreeId]: destTerminals
      },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [sourceWorktreeId]: sourceUnified.filter((tab) => !movingUnifiedIds.has(tab.id)),
        [destWorktreeId]: [
          ...destUnifiedExisting.filter((tab) => !movingUnifiedIds.has(tab.id)),
          ...movedUnified
        ]
      },
      groupsByWorktree: {
        ...destEnsured.groupsByWorktree,
        [sourceWorktreeId]: sourceGroups,
        [destWorktreeId]: destGroups
      },
      layoutByWorktree: nextLayoutByWorktree,
      activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
      tabBarOrderByWorktree: {
        ...state.tabBarOrderByWorktree,
        [sourceWorktreeId]: sourceBar,
        [destWorktreeId]: destBar
      },
      activeTabIdByWorktree: {
        ...state.activeTabIdByWorktree,
        [sourceWorktreeId]:
          state.activeTabIdByWorktree[sourceWorktreeId] === tabId
            ? (sourceTerminals[0]?.id ?? null)
            : state.activeTabIdByWorktree[sourceWorktreeId],
        [destWorktreeId]: tabId
      },
      activeTabId: state.activeTabId === tabId ? (sourceTerminals[0]?.id ?? null) : state.activeTabId,
      agentStatusByPaneKey: remintWorktreeId(state.agentStatusByPaneKey, tabId, destWorktreeId),
      retainedAgentsByPaneKey: remintRetainedWorktreeId(
        state.retainedAgentsByPaneKey,
        tabId,
        destWorktreeId
      ),
      sleepingAgentSessionsByPaneKey: remintWorktreeId(
        state.sleepingAgentSessionsByPaneKey,
        tabId,
        destWorktreeId
      )
    }
  }
}

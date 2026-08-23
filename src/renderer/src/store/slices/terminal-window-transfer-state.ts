import type { AppState } from '../types'
import type { TabGroup, TabGroupLayoutNode } from '../../../../shared/tab-types'
import type { TerminalWindowTransferSeed } from '../../../../shared/terminal-window-transfer'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import { dedupeTabOrder, pushRecentTabId, sanitizeRecentTabIds } from './tab-group-state'
import {
  buildTransferredUnifiedTab,
  validateTransferredTerminalImport
} from './terminal-window-transfer-import-validation'

type TransferStateResult = { ok: true; patch: Partial<AppState> | null } | { ok: false }

function chooseGroup(
  state: AppState,
  seed: TerminalWindowTransferSeed,
  restoreSource: boolean
): { group: TabGroup; existed: boolean } {
  const groups = state.groupsByWorktree[seed.worktreeId] ?? []
  const active = groups.find(({ id }) => id === state.activeGroupIdByWorktree[seed.worktreeId])
  const seeded = groups.find(({ id }) => id === seed.group.id)
  const existing = restoreSource ? seeded : (active ?? seeded)
  return {
    group:
      existing ??
      ({
        ...structuredClone(seed.group),
        activeTabId: null,
        tabOrder: [],
        recentTabIds: []
      } satisfies TabGroup),
    existed: Boolean(existing)
  }
}

function workspaceHasContent(state: AppState, worktreeId: string): boolean {
  return Boolean(
    state.tabsByWorktree[worktreeId]?.length ||
    state.unifiedTabsByWorktree[worktreeId]?.length ||
    state.openFiles.some((file) => file.worktreeId === worktreeId) ||
    state.browserTabsByWorktree[worktreeId]?.length ||
    state.groupsByWorktree[worktreeId]?.some(({ tabOrder }) => tabOrder.length > 0)
  )
}

function restoreIdAtPriorIndex(
  current: readonly string[],
  prior: readonly string[],
  tabId: string
): string[] {
  const next = current.filter((id) => id !== tabId)
  const index = prior.indexOf(tabId)
  next.splice(Math.min(index === -1 ? next.length : index, next.length), 0, tabId)
  return next
}

function appendGroupLayout(
  current: TabGroupLayoutNode | undefined,
  groupId: string
): TabGroupLayoutNode {
  if (!current) {
    return { type: 'leaf', groupId }
  }
  const stack = [current]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'leaf') {
      if (node.groupId === groupId) {
        return current
      }
    } else {
      stack.push(node.first, node.second)
    }
  }
  return {
    type: 'split',
    direction: 'horizontal',
    first: current,
    second: { type: 'leaf', groupId }
  }
}

export function buildTransferredTerminalImportPatch(
  state: AppState,
  seed: TerminalWindowTransferSeed,
  restoreSource = false
): TransferStateResult {
  const validation = validateTransferredTerminalImport(state, seed)
  if (validation === 'reject') {
    return { ok: false }
  }
  if (validation === 'existing') {
    return { ok: true, patch: null }
  }

  const shouldActivate =
    !workspaceHasContent(state, seed.worktreeId) ||
    (restoreSource && seed.group.activeTabId === seed.tabId)
  const { group, existed } = chooseGroup(state, seed, restoreSource)
  const tabOrder = restoreSource
    ? restoreIdAtPriorIndex(group.tabOrder, seed.group.tabOrder, seed.tabId)
    : dedupeTabOrder([...group.tabOrder, seed.tabId])
  const activeTabId = restoreSource
    ? group.activeTabId === seed.tabId || seed.group.activeTabId === seed.tabId
      ? seed.group.activeTabId
      : group.activeTabId
    : (group.activeTabId ?? seed.tabId)
  const recentTabIds = restoreSource
    ? seed.group.recentTabIds?.includes(seed.tabId)
      ? restoreIdAtPriorIndex(group.recentTabIds ?? [], seed.group.recentTabIds, seed.tabId)
      : (group.recentTabIds ?? []).filter((id) => id !== seed.tabId)
    : pushRecentTabId(sanitizeRecentTabIds(group.recentTabIds, tabOrder), seed.tabId)
  const nextGroup: TabGroup = {
    ...group,
    activeTabId,
    tabOrder,
    recentTabIds
  }
  const groups = state.groupsByWorktree[seed.worktreeId] ?? []
  const nextGroups = existed
    ? groups.map((candidate) => (candidate.id === group.id ? nextGroup : candidate))
    : [...groups, nextGroup]
  const unifiedTab = buildTransferredUnifiedTab(seed, group.id, tabOrder.indexOf(seed.tabId))
  const folderWorkspace = parseWorkspaceKey(seed.canonicalWorkspaceKey)?.type === 'folder'
  const primaryPtyId = seed.tab.ptyId ?? seed.ptyIds[0]

  return {
    ok: true,
    patch: {
      repos:
        folderWorkspace || state.repos.some(({ id }) => id === seed.repo.id)
          ? state.repos
          : [...state.repos, structuredClone(seed.repo)],
      tabsByWorktree: {
        ...state.tabsByWorktree,
        [seed.worktreeId]: [
          ...(state.tabsByWorktree[seed.worktreeId] ?? []),
          structuredClone(seed.tab)
        ]
      },
      unifiedTabsByWorktree: {
        ...state.unifiedTabsByWorktree,
        [seed.worktreeId]: [...(state.unifiedTabsByWorktree[seed.worktreeId] ?? []), unifiedTab]
      },
      groupsByWorktree: { ...state.groupsByWorktree, [seed.worktreeId]: nextGroups },
      layoutByWorktree: {
        ...state.layoutByWorktree,
        [seed.worktreeId]: appendGroupLayout(state.layoutByWorktree[seed.worktreeId], group.id)
      },
      ptyIdsByTabId: { ...state.ptyIdsByTabId, [seed.tabId]: [...seed.ptyIds] },
      terminalLayoutsByTabId: {
        ...state.terminalLayoutsByTabId,
        [seed.tabId]: structuredClone(seed.layout)
      },
      lastKnownRelayPtyIdByTabId: primaryPtyId
        ? { ...state.lastKnownRelayPtyIdByTabId, [seed.tabId]: primaryPtyId }
        : state.lastKnownRelayPtyIdByTabId,
      tabBarOrderByWorktree: {
        ...state.tabBarOrderByWorktree,
        [seed.worktreeId]: dedupeTabOrder([
          ...(state.tabBarOrderByWorktree[seed.worktreeId] ?? []),
          seed.tabId
        ])
      },
      ...(shouldActivate
        ? {
            activeRepoId: folderWorkspace ? null : seed.repo.id,
            activeWorktreeId: seed.worktreeId,
            activeWorkspaceKey: seed.canonicalWorkspaceKey,
            activeWorkspaceExecutionHostId: seed.hostId,
            activeGroupIdByWorktree: {
              ...state.activeGroupIdByWorktree,
              [seed.worktreeId]: group.id
            },
            activeTabId: seed.tabId,
            activeTabIdByWorktree: {
              ...state.activeTabIdByWorktree,
              [seed.worktreeId]: seed.tabId
            },
            activeTabType: 'terminal' as const,
            activeTabTypeByWorktree: {
              ...state.activeTabTypeByWorktree,
              [seed.worktreeId]: 'terminal' as const
            }
          }
        : {})
    }
  }
}

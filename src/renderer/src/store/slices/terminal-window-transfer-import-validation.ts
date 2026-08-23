import type { AppState } from '../types'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalWindowTransferSeed } from '../../../../shared/terminal-window-transfer'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import {
  isWorkspaceKey,
  parseWorkspaceKey,
  worktreeWorkspaceKey
} from '../../../../shared/workspace-scope'
import { terminalLayoutEqual } from '@/lib/terminal-layout-equality'

export type TerminalTransferImportValidation = 'new' | 'existing' | 'reject'

function unique(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))]
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left)
  const rightSet = new Set(right)
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value))
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonEqual(value, right[index]))
    )
  }
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false
  }
  const leftRecord = left as Record<string, unknown>
  const rightRecord = right as Record<string, unknown>
  const keys = Object.keys(leftRecord)
  return (
    keys.length === Object.keys(rightRecord).length &&
    keys.every(
      (key) => Object.hasOwn(rightRecord, key) && jsonEqual(leftRecord[key], rightRecord[key])
    )
  )
}

function seedIsConsistent(seed: TerminalWindowTransferSeed): boolean {
  const ptyIds = unique([seed.tab.ptyId, ...Object.values(seed.layout.ptyIdsByLeafId ?? {})])
  const canonicalWorkspaceKey = isWorkspaceKey(seed.worktreeId)
    ? seed.worktreeId
    : worktreeWorkspaceKey(seed.worktreeId)
  const workspaceScope = parseWorkspaceKey(seed.canonicalWorkspaceKey)
  return (
    seed.tabId === seed.tab.id &&
    seed.worktreeId === seed.tab.worktreeId &&
    seed.group.worktreeId === seed.worktreeId &&
    seed.group.tabOrder.includes(seed.tabId) &&
    seed.canonicalWorkspaceKey === canonicalWorkspaceKey &&
    (workspaceScope?.type === 'folder' ||
      (workspaceScope?.type === 'worktree' &&
        getRepoIdFromWorktreeId(workspaceScope.worktreeId) === seed.repo.id)) &&
    getRepoExecutionHostId(seed.repo) === seed.hostId &&
    seed.ptyIds.length > 0 &&
    new Set(seed.ptyIds).size === seed.ptyIds.length &&
    sameSet(seed.ptyIds, ptyIds)
  )
}

function hasForeignPtyBacking(state: AppState, seed: TerminalWindowTransferSeed): boolean {
  const ptyIds = new Set(seed.ptyIds)
  for (const [tabId, ids] of Object.entries(state.ptyIdsByTabId)) {
    if (tabId !== seed.tabId && ids.some((id) => ptyIds.has(id))) {
      return true
    }
  }
  for (const [tabId, layout] of Object.entries(state.terminalLayoutsByTabId)) {
    if (
      tabId !== seed.tabId &&
      Object.values(layout.ptyIdsByLeafId ?? {}).some((id) => ptyIds.has(id))
    ) {
      return true
    }
  }
  return (
    Object.values(state.tabsByWorktree)
      .flat()
      .some((tab) => tab.id !== seed.tabId && Boolean(tab.ptyId && ptyIds.has(tab.ptyId))) ||
    Object.entries(state.lastKnownRelayPtyIdByTabId).some(
      ([tabId, ptyId]) => tabId !== seed.tabId && ptyIds.has(ptyId)
    ) ||
    Object.entries(state.directSshLivePtyBindingByTabId).some(
      ([tabId, binding]) => tabId !== seed.tabId && ptyIds.has(binding.ptyId)
    )
  )
}

function targetGroupSelectionIsUnambiguous(
  state: AppState,
  seed: TerminalWindowTransferSeed
): boolean {
  const groups = state.groupsByWorktree[seed.worktreeId] ?? []
  if (new Set(groups.map(({ id }) => id)).size !== groups.length) {
    return false
  }
  const activeGroupId = state.activeGroupIdByWorktree[seed.worktreeId]
  const chosen =
    groups.find(({ id }) => id === activeGroupId) ?? groups.find(({ id }) => id === seed.group.id)
  return !chosen || chosen.worktreeId === seed.worktreeId
}

export function buildTransferredUnifiedTab(
  seed: TerminalWindowTransferSeed,
  groupId: string,
  sortOrder: number
): Tab {
  return {
    id: seed.tabId,
    entityId: seed.tabId,
    groupId,
    worktreeId: seed.worktreeId,
    executionHostId: seed.hostId,
    contentType: 'terminal',
    label: seed.tab.title,
    ...(seed.tab.generatedTitle ? { generatedLabel: seed.tab.generatedTitle } : {}),
    ...(seed.tab.aiVaultTitle ? { aiVaultTitle: seed.tab.aiVaultTitle } : {}),
    ...(seed.tab.quickCommandLabel ? { quickCommandLabel: seed.tab.quickCommandLabel } : {}),
    customLabel: seed.tab.customTitle,
    color: seed.tab.color,
    sortOrder,
    createdAt: seed.tab.createdAt,
    ...(seed.tab.isPinned ? { isPinned: true } : {}),
    ...(seed.tab.viewMode ? { viewMode: seed.tab.viewMode } : {})
  }
}

function importedBackingMatches(state: AppState, seed: TerminalWindowTransferSeed): boolean {
  const terminalTabs = Object.values(state.tabsByWorktree)
    .flat()
    .filter(({ id }) => id === seed.tabId)
  const unified = Object.values(state.unifiedTabsByWorktree)
    .flat()
    .filter(({ id, entityId }) => id === seed.tabId || entityId === seed.tabId)
  const layout = state.terminalLayoutsByTabId[seed.tabId]
  const terminalTab = terminalTabs[0]
  const unifiedTab = unified[0]
  const lastKnownPtyId = state.lastKnownRelayPtyIdByTabId[seed.tabId]
  const directSshPtyId = state.directSshLivePtyBindingByTabId[seed.tabId]?.ptyId
  if (
    terminalTabs.length !== 1 ||
    terminalTab.id !== seed.tabId ||
    terminalTab.worktreeId !== seed.worktreeId ||
    terminalTab.ptyId !== seed.tab.ptyId ||
    !layout ||
    !jsonEqual(layout.ptyIdsByLeafId ?? {}, seed.layout.ptyIdsByLeafId ?? {}) ||
    !sameSet(state.ptyIdsByTabId[seed.tabId] ?? [], seed.ptyIds) ||
    unified.length !== 1 ||
    unifiedTab.contentType !== 'terminal' ||
    unifiedTab.id !== seed.tabId ||
    unifiedTab.entityId !== seed.tabId ||
    unifiedTab.worktreeId !== seed.worktreeId ||
    Boolean(lastKnownPtyId && !seed.ptyIds.includes(lastKnownPtyId)) ||
    Boolean(directSshPtyId && !seed.ptyIds.includes(directSshPtyId))
  ) {
    return false
  }
  const memberships = (state.groupsByWorktree[seed.worktreeId] ?? []).flatMap((group) =>
    group.tabOrder.filter((id) => id === seed.tabId).map(() => group)
  )
  return (
    memberships.length === 1 &&
    memberships[0].id === unifiedTab.groupId &&
    memberships[0].worktreeId === seed.worktreeId
  )
}

function hasMismatchedTabIdentityBacking(
  state: AppState,
  seed: TerminalWindowTransferSeed
): boolean {
  const stagedLayout = state.terminalLayoutsByTabId[seed.tabId]
  const stagedPtyIds = state.ptyIdsByTabId[seed.tabId]
  return (
    Object.values(state.unifiedTabsByWorktree)
      .flat()
      .some(({ id, entityId }) => id === seed.tabId || entityId === seed.tabId) ||
    state.openFiles.some(({ id }) => id === seed.tabId) ||
    Object.values(state.browserTabsByWorktree)
      .flat()
      .some(({ id }) => id === seed.tabId) ||
    Object.values(state.groupsByWorktree)
      .flat()
      .some(({ tabOrder }) => tabOrder.includes(seed.tabId)) ||
    Boolean(stagedLayout && !terminalLayoutEqual(stagedLayout, seed.layout)) ||
    Boolean(stagedPtyIds && !sameSet(stagedPtyIds, seed.ptyIds)) ||
    Boolean(
      state.lastKnownRelayPtyIdByTabId[seed.tabId] &&
      !seed.ptyIds.includes(state.lastKnownRelayPtyIdByTabId[seed.tabId])
    ) ||
    Object.hasOwn(state.directSshPaneRetryByTabId, seed.tabId) ||
    Object.hasOwn(state.directSshLivePtyBindingByTabId, seed.tabId)
  )
}

export function validateTransferredTerminalImport(
  state: AppState,
  seed: TerminalWindowTransferSeed
): TerminalTransferImportValidation {
  if (
    !seedIsConsistent(seed) ||
    hasForeignPtyBacking(state, seed) ||
    !targetGroupSelectionIsUnambiguous(state, seed)
  ) {
    return 'reject'
  }
  const hasTerminalTab = Object.values(state.tabsByWorktree)
    .flat()
    .some(({ id }) => id === seed.tabId)
  if (hasTerminalTab) {
    return importedBackingMatches(state, seed) ? 'existing' : 'reject'
  }
  return hasMismatchedTabIdentityBacking(state, seed) ? 'reject' : 'new'
}

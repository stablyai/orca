/* eslint-disable max-lines -- Why: web session-tab sync reconciles terminal,
 * unified-tab, group, and PTY maps atomically so host-published surfaces don't
 * leave the web client in a split-brain tab state. */
import { useEffect } from 'react'
import type { AppState } from '../store'
import { useAppStore } from '../store'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type {
  RuntimeMobileSessionTabsResult,
  RuntimeMobileSessionTerminalClientTab
} from '../../../shared/runtime-types'
import type { Tab, TabGroup, TerminalLayoutSnapshot, TerminalTab } from '../../../shared/types'
import { getRemoteRuntimePtyEnvironmentId, toRemoteRuntimePtyId } from './runtime-terminal-stream'

const WEB_SESSION_GROUP_PREFIX = 'web-session-tabs:'
const TERMINAL_SURFACE_SEPARATOR = '::pane:'

type SessionTabsStreamEvent =
  | (RuntimeMobileSessionTabsResult & { type: 'snapshot' | 'updated' })
  | { type: 'end' }

export type WebSessionTabsSyncState = Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
  | 'activeWorktreeId'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'ptyIdsByTabId'
  | 'tabBarOrderByWorktree'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'unifiedTabsByWorktree'
  | 'unreadTerminalTabs'
>

function isWebClient(): boolean {
  return Boolean((window as unknown as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__)
}

function emptyRemoteTerminalLayout(): TerminalLayoutSnapshot {
  return {
    root: null,
    activeLeafId: null,
    expandedLeafId: null
  }
}

function isReadyTerminalTab(
  tab: RuntimeMobileSessionTabsResult['tabs'][number]
): tab is RuntimeMobileSessionTerminalClientTab & { status: 'ready' } {
  return tab.type === 'terminal' && tab.status === 'ready' && tab.terminal.trim().length > 0
}

function isRuntimeTerminalTabForEnvironment(tab: TerminalTab, environmentId: string): boolean {
  if (!tab.ptyId) {
    return false
  }
  return getRemoteRuntimePtyEnvironmentId(tab.ptyId) === environmentId
}

function isMirroredTerminalSurfaceId(tabId: string): boolean {
  return tabId.includes(TERMINAL_SURFACE_SEPARATOR)
}

function shouldReplaceTerminalTab(
  tab: TerminalTab,
  environmentId: string,
  nextRemotePtyIds: ReadonlySet<string>
): boolean {
  if (!isRuntimeTerminalTabForEnvironment(tab, environmentId)) {
    return false
  }
  // Why: web-created remote tabs use local UUIDs until the host publishes the
  // corresponding session surface. Only retire them once their PTY is present
  // in the host snapshot, while always pruning prior mirrored surface IDs.
  return (
    isMirroredTerminalSurfaceId(tab.id) || (tab.ptyId !== null && nextRemotePtyIds.has(tab.ptyId))
  )
}

function buildMirroredTerminalTabs(
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  existingById: ReadonlyMap<string, TerminalTab>,
  sortOffset: number,
  now: number
): TerminalTab[] {
  return snapshot.tabs.filter(isReadyTerminalTab).map((tab, index) => {
    const ptyId = toRemoteRuntimePtyId(tab.terminal, environmentId)
    const existing = existingById.get(tab.id)
    const title = tab.title.trim() || 'Terminal'
    return {
      id: tab.id,
      ptyId,
      worktreeId: snapshot.worktree,
      title,
      defaultTitle: existing?.defaultTitle ?? title,
      customTitle: existing?.customTitle ?? null,
      color: existing?.color ?? null,
      sortOrder: sortOffset + index,
      createdAt: existing?.createdAt ?? now + index
    }
  })
}

function buildTerminalUnifiedTab(tab: TerminalTab, groupId: string): Tab {
  return {
    id: tab.id,
    entityId: tab.id,
    groupId,
    worktreeId: tab.worktreeId,
    contentType: 'terminal',
    label: tab.title,
    customLabel: tab.customTitle,
    color: tab.color,
    sortOrder: tab.sortOrder,
    createdAt: tab.createdAt,
    isPreview: false,
    isPinned: false
  }
}

function chooseTargetGroupId(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult
): string {
  const groups = state.groupsByWorktree[snapshot.worktree] ?? []
  const preferred =
    groups.find((group) => group.id === snapshot.activeGroupId) ??
    groups.find((group) => group.id === state.activeGroupIdByWorktree[snapshot.worktree]) ??
    groups[0]
  return (
    preferred?.id ?? snapshot.activeGroupId ?? `${WEB_SESSION_GROUP_PREFIX}${snapshot.worktree}`
  )
}

function sameStringArray(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false
  }
  return a.every((value, index) => value === b[index])
}

function sanitizeRecentTabIds(recent: string[] | undefined, tabOrder: string[]): string[] {
  if (!recent || recent.length === 0) {
    return []
  }
  const valid = new Set(tabOrder)
  const seen = new Set<string>()
  const reversed: string[] = []
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const id = recent[i]
    if (!valid.has(id) || seen.has(id)) {
      continue
    }
    seen.add(id)
    reversed.push(id)
  }
  return reversed.reverse()
}

function pushRecentTabId(recent: string[] | undefined, tabId: string): string[] {
  const base = recent ?? []
  if (base.length > 0 && base.at(-1) === tabId) {
    return base
  }
  return [...base.filter((id) => id !== tabId), tabId]
}

function withWorktreeEntry<T>(
  record: Record<string, T>,
  key: string,
  value: T | null,
  equal: (a: T | undefined, b: T | null) => boolean
): Record<string, T> {
  if (equal(record[key], value)) {
    return record
  }
  const next = { ...record }
  if (value === null) {
    delete next[key]
  } else {
    next[key] = value
  }
  return next
}

function terminalTabEqual(a: TerminalTab, b: TerminalTab): boolean {
  return (
    a.id === b.id &&
    a.ptyId === b.ptyId &&
    a.worktreeId === b.worktreeId &&
    a.title === b.title &&
    a.defaultTitle === b.defaultTitle &&
    a.customTitle === b.customTitle &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.generation === b.generation &&
    a.shellOverride === b.shellOverride &&
    a.pendingActivationSpawn === b.pendingActivationSpawn
  )
}

function sameTerminalTabs(
  a: readonly TerminalTab[] | undefined,
  b: readonly TerminalTab[] | null
): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => terminalTabEqual(tab, right[index]!))
}

function tabEqual(a: Tab, b: Tab): boolean {
  return (
    a.id === b.id &&
    a.entityId === b.entityId &&
    a.groupId === b.groupId &&
    a.worktreeId === b.worktreeId &&
    a.contentType === b.contentType &&
    a.label === b.label &&
    a.customLabel === b.customLabel &&
    a.color === b.color &&
    a.sortOrder === b.sortOrder &&
    a.createdAt === b.createdAt &&
    a.isPreview === b.isPreview &&
    a.isPinned === b.isPinned
  )
}

function sameUnifiedTabs(a: readonly Tab[] | undefined, b: readonly Tab[] | null): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((tab, index) => tabEqual(tab, right[index]!))
}

function groupEqual(a: TabGroup, b: TabGroup): boolean {
  return (
    a.id === b.id &&
    a.worktreeId === b.worktreeId &&
    a.activeTabId === b.activeTabId &&
    sameStringArray(a.tabOrder, b.tabOrder) &&
    sameStringArray(a.recentTabIds ?? [], b.recentTabIds ?? [])
  )
}

function sameGroups(a: readonly TabGroup[] | undefined, b: readonly TabGroup[] | null): boolean {
  const left = a ?? []
  const right = b ?? []
  if (left.length !== right.length) {
    return false
  }
  return left.every((group, index) => groupEqual(group, right[index]!))
}

export function applyWebSessionTabsSnapshot(
  state: WebSessionTabsSyncState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  now = Date.now()
): WebSessionTabsSyncState | Partial<WebSessionTabsSyncState> {
  const worktreeId = snapshot.worktree
  const currentTerminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const existingTerminalById = new Map(currentTerminalTabs.map((tab) => [tab.id, tab]))
  const readyTerminalTabs = snapshot.tabs.filter(isReadyTerminalTab)
  const nextRemotePtyIds = new Set(
    readyTerminalTabs.map((tab) => toRemoteRuntimePtyId(tab.terminal, environmentId))
  )
  const retainedTerminalTabs = currentTerminalTabs.filter(
    (tab) => !shouldReplaceTerminalTab(tab, environmentId, nextRemotePtyIds)
  )
  const mirroredTerminalTabs = buildMirroredTerminalTabs(
    snapshot,
    environmentId,
    existingTerminalById,
    retainedTerminalTabs.length,
    now
  )
  const nextTerminalTabs =
    retainedTerminalTabs.length + mirroredTerminalTabs.length > 0
      ? [...retainedTerminalTabs, ...mirroredTerminalTabs]
      : null
  const mirroredTerminalIds = new Set(mirroredTerminalTabs.map((tab) => tab.id))
  const removedTerminalIds = new Set(
    currentTerminalTabs
      .filter((tab) => !retainedTerminalTabs.some((retained) => retained.id === tab.id))
      .map((tab) => tab.id)
  )

  const targetGroupId = chooseTargetGroupId(state, snapshot)
  const currentUnifiedTabs = state.unifiedTabsByWorktree[worktreeId] ?? []
  const retainedUnifiedTabs = currentUnifiedTabs.filter((tab) => {
    if (tab.contentType !== 'terminal') {
      return true
    }
    if (removedTerminalIds.has(tab.entityId) || removedTerminalIds.has(tab.id)) {
      return false
    }
    return !mirroredTerminalIds.has(tab.entityId) && !mirroredTerminalIds.has(tab.id)
  })
  const mirroredUnifiedTabs = mirroredTerminalTabs.map((tab) =>
    buildTerminalUnifiedTab(tab, targetGroupId)
  )
  const nextUnifiedTabs =
    retainedUnifiedTabs.length + mirroredUnifiedTabs.length > 0
      ? [...retainedUnifiedTabs, ...mirroredUnifiedTabs]
      : null
  const validUnifiedTabIds = new Set(nextUnifiedTabs?.map((tab) => tab.id) ?? [])
  const activeMirroredTerminalId =
    readyTerminalTabs.find((tab) => tab.id === snapshot.activeTabId)?.id ??
    readyTerminalTabs.find((tab) => tab.isActive)?.id ??
    null
  const currentActiveTerminalStillExists =
    state.activeTabIdByWorktree[worktreeId] &&
    (nextTerminalTabs ?? []).some((tab) => tab.id === state.activeTabIdByWorktree[worktreeId])
      ? state.activeTabIdByWorktree[worktreeId]
      : null
  const nextActiveTerminalId =
    snapshot.activeTabType === 'terminal'
      ? (activeMirroredTerminalId ??
        mirroredTerminalTabs[0]?.id ??
        currentActiveTerminalStillExists)
      : (currentActiveTerminalStillExists ?? mirroredTerminalTabs[0]?.id ?? null)

  const currentGroups = state.groupsByWorktree[worktreeId] ?? []
  const nextGroups = (() => {
    if (!nextUnifiedTabs || nextUnifiedTabs.length === 0) {
      return null
    }
    const strippedGroups = currentGroups.map((group) => ({
      ...group,
      tabOrder: group.tabOrder.filter(
        (tabId) => validUnifiedTabIds.has(tabId) && !mirroredTerminalIds.has(tabId)
      ),
      recentTabIds: sanitizeRecentTabIds(
        group.recentTabIds,
        group.tabOrder.filter(
          (tabId) => validUnifiedTabIds.has(tabId) && !mirroredTerminalIds.has(tabId)
        )
      )
    }))
    const target = strippedGroups.find((group) => group.id === targetGroupId) ?? {
      id: targetGroupId,
      worktreeId,
      activeTabId: null,
      tabOrder: [],
      recentTabIds: []
    }
    const targetOrder = [
      ...target.tabOrder.filter((tabId) => validUnifiedTabIds.has(tabId)),
      ...mirroredTerminalTabs.map((tab) => tab.id)
    ]
    const targetActiveTabId =
      nextActiveTerminalId && targetOrder.includes(nextActiveTerminalId)
        ? nextActiveTerminalId
        : target.activeTabId && targetOrder.includes(target.activeTabId)
          ? target.activeTabId
          : (targetOrder[0] ?? null)
    const updatedTarget: TabGroup = {
      ...target,
      worktreeId,
      tabOrder: targetOrder,
      activeTabId: targetActiveTabId,
      recentTabIds: targetActiveTabId
        ? pushRecentTabId(sanitizeRecentTabIds(target.recentTabIds, targetOrder), targetActiveTabId)
        : []
    }
    const merged = strippedGroups.some((group) => group.id === targetGroupId)
      ? strippedGroups.map((group) => (group.id === targetGroupId ? updatedTarget : group))
      : [...strippedGroups, updatedTarget]
    return merged.filter((group) => group.id === targetGroupId || group.tabOrder.length > 0)
  })()

  const nextTabBarOrder = (() => {
    const current = state.tabBarOrderByWorktree[worktreeId] ?? []
    const validTabBarIds = new Set([
      ...retainedUnifiedTabs.map((tab) => tab.id),
      ...mirroredUnifiedTabs.map((tab) => tab.id)
    ])
    return [
      ...current.filter((tabId) => validTabBarIds.has(tabId) && !mirroredTerminalIds.has(tabId)),
      ...mirroredTerminalTabs.map((tab) => tab.id)
    ]
  })()

  let nextPtyIdsByTabId = state.ptyIdsByTabId
  for (const removedId of removedTerminalIds) {
    if (nextPtyIdsByTabId[removedId]) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId ? { ...state.ptyIdsByTabId } : nextPtyIdsByTabId
      delete nextPtyIdsByTabId[removedId]
    }
  }
  for (const tab of mirroredTerminalTabs) {
    const current = nextPtyIdsByTabId[tab.id] ?? []
    if (!sameStringArray(current, [tab.ptyId!])) {
      nextPtyIdsByTabId =
        nextPtyIdsByTabId === state.ptyIdsByTabId ? { ...state.ptyIdsByTabId } : nextPtyIdsByTabId
      nextPtyIdsByTabId[tab.id] = [tab.ptyId!]
    }
  }

  let nextTerminalLayoutsByTabId = state.terminalLayoutsByTabId
  for (const removedId of removedTerminalIds) {
    if (nextTerminalLayoutsByTabId[removedId]) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? { ...state.terminalLayoutsByTabId }
          : nextTerminalLayoutsByTabId
      delete nextTerminalLayoutsByTabId[removedId]
    }
  }
  for (const tab of mirroredTerminalTabs) {
    if (!nextTerminalLayoutsByTabId[tab.id]) {
      nextTerminalLayoutsByTabId =
        nextTerminalLayoutsByTabId === state.terminalLayoutsByTabId
          ? { ...state.terminalLayoutsByTabId }
          : nextTerminalLayoutsByTabId
      nextTerminalLayoutsByTabId[tab.id] = emptyRemoteTerminalLayout()
    }
  }

  let nextUnreadTerminalTabs = state.unreadTerminalTabs
  for (const removedId of removedTerminalIds) {
    if (nextUnreadTerminalTabs[removedId]) {
      nextUnreadTerminalTabs =
        nextUnreadTerminalTabs === state.unreadTerminalTabs
          ? { ...state.unreadTerminalTabs }
          : nextUnreadTerminalTabs
      delete nextUnreadTerminalTabs[removedId]
    }
  }

  const nextTabsByWorktree = withWorktreeEntry(
    state.tabsByWorktree,
    worktreeId,
    nextTerminalTabs,
    sameTerminalTabs
  )
  const nextUnifiedTabsByWorktree = withWorktreeEntry(
    state.unifiedTabsByWorktree,
    worktreeId,
    nextUnifiedTabs,
    sameUnifiedTabs
  )
  const nextGroupsByWorktree = withWorktreeEntry(
    state.groupsByWorktree,
    worktreeId,
    nextGroups,
    sameGroups
  )
  const nextActiveGroupIdByWorktree =
    nextGroups && state.activeGroupIdByWorktree[worktreeId] !== targetGroupId
      ? { ...state.activeGroupIdByWorktree, [worktreeId]: targetGroupId }
      : state.activeGroupIdByWorktree
  const nextLayoutByWorktree =
    nextGroups && !state.layoutByWorktree[worktreeId]
      ? {
          ...state.layoutByWorktree,
          [worktreeId]: { type: 'leaf' as const, groupId: targetGroupId }
        }
      : state.layoutByWorktree
  const nextTabBarOrderByWorktree = withWorktreeEntry(
    state.tabBarOrderByWorktree,
    worktreeId,
    nextTabBarOrder.length > 0 ? nextTabBarOrder : null,
    (a, b) => sameStringArray(a ?? [], b ?? [])
  )
  const nextActiveTabIdByWorktree =
    (state.activeTabIdByWorktree[worktreeId] ?? null) !== nextActiveTerminalId
      ? { ...state.activeTabIdByWorktree, [worktreeId]: nextActiveTerminalId }
      : state.activeTabIdByWorktree
  const shouldSurfaceTerminal =
    snapshot.activeTabType === 'terminal' &&
    nextActiveTerminalId !== null &&
    state.activeWorktreeId === worktreeId
  const nextActiveTabId = shouldSurfaceTerminal ? nextActiveTerminalId : state.activeTabId
  const nextActiveTabType = shouldSurfaceTerminal ? 'terminal' : state.activeTabType
  const nextActiveTabTypeByWorktree =
    shouldSurfaceTerminal && state.activeTabTypeByWorktree[worktreeId] !== 'terminal'
      ? { ...state.activeTabTypeByWorktree, [worktreeId]: 'terminal' as const }
      : state.activeTabTypeByWorktree

  const patch: Partial<WebSessionTabsSyncState> = {
    ...(nextTabsByWorktree !== state.tabsByWorktree ? { tabsByWorktree: nextTabsByWorktree } : {}),
    ...(nextUnifiedTabsByWorktree !== state.unifiedTabsByWorktree
      ? { unifiedTabsByWorktree: nextUnifiedTabsByWorktree }
      : {}),
    ...(nextGroupsByWorktree !== state.groupsByWorktree
      ? { groupsByWorktree: nextGroupsByWorktree }
      : {}),
    ...(nextActiveGroupIdByWorktree !== state.activeGroupIdByWorktree
      ? { activeGroupIdByWorktree: nextActiveGroupIdByWorktree }
      : {}),
    ...(nextLayoutByWorktree !== state.layoutByWorktree
      ? { layoutByWorktree: nextLayoutByWorktree }
      : {}),
    ...(nextTabBarOrderByWorktree !== state.tabBarOrderByWorktree
      ? { tabBarOrderByWorktree: nextTabBarOrderByWorktree }
      : {}),
    ...(nextPtyIdsByTabId !== state.ptyIdsByTabId ? { ptyIdsByTabId: nextPtyIdsByTabId } : {}),
    ...(nextTerminalLayoutsByTabId !== state.terminalLayoutsByTabId
      ? { terminalLayoutsByTabId: nextTerminalLayoutsByTabId }
      : {}),
    ...(nextUnreadTerminalTabs !== state.unreadTerminalTabs
      ? { unreadTerminalTabs: nextUnreadTerminalTabs }
      : {}),
    ...(nextActiveTabIdByWorktree !== state.activeTabIdByWorktree
      ? { activeTabIdByWorktree: nextActiveTabIdByWorktree }
      : {}),
    ...(nextActiveTabId !== state.activeTabId ? { activeTabId: nextActiveTabId } : {}),
    ...(nextActiveTabType !== state.activeTabType ? { activeTabType: nextActiveTabType } : {}),
    ...(nextActiveTabTypeByWorktree !== state.activeTabTypeByWorktree
      ? { activeTabTypeByWorktree: nextActiveTabTypeByWorktree }
      : {})
  }

  return Object.keys(patch).length === 0 ? state : patch
}

export function useWebSessionTabsSync(): void {
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeRuntimeEnvironmentId = useAppStore(
    (state) => state.settings?.activeRuntimeEnvironmentId ?? null
  )

  useEffect(() => {
    const environmentId = activeRuntimeEnvironmentId?.trim()
    if (!isWebClient() || !activeWorktreeId || !environmentId) {
      return
    }

    let disposed = false
    let unsubscribe: (() => void) | null = null
    void window.api.runtimeEnvironments
      .subscribe(
        {
          selector: environmentId,
          method: 'session.tabs.subscribe',
          params: { worktree: `id:${activeWorktreeId}` },
          timeoutMs: 15_000
        },
        {
          onResponse: (response: RuntimeRpcResponse<unknown>) => {
            if (response.ok === false) {
              console.warn('[web-session-tabs-sync] subscription failed:', response.error.message)
              return
            }
            const event = response.result as SessionTabsStreamEvent
            if (event.type !== 'snapshot' && event.type !== 'updated') {
              return
            }
            useAppStore.setState((state) =>
              applyWebSessionTabsSnapshot(state, event, environmentId)
            )
          },
          onError: (error) => {
            console.warn('[web-session-tabs-sync] subscription error:', error.message)
          }
        }
      )
      .then((handle) => {
        if (disposed) {
          handle.unsubscribe()
          return
        }
        unsubscribe = handle.unsubscribe
      })
      .catch((error) => {
        if (!disposed) {
          console.warn(
            '[web-session-tabs-sync] failed to subscribe:',
            error instanceof Error ? error.message : String(error)
          )
        }
      })

    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [activeRuntimeEnvironmentId, activeWorktreeId])
}

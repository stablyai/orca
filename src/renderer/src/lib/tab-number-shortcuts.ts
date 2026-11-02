import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { dedupeTabOrder } from '../../../shared/workspace-layout/tab-order'
import type { Tab } from '../../../shared/tab-types'
import { activateWebRuntimeSessionTab } from '@/runtime/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'

type TabNumberShortcutState = Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activeView'
  | 'activeWorktreeId'
  | 'groupsByWorktree'
  | 'repos'
  | 'settings'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
>

export function resolveTabNumberShortcutTarget(
  state: TabNumberShortcutState,
  index: number
): Tab | null {
  if (state.activeView !== 'terminal' || state.activeWorktreeId === null || index < 0) {
    return null
  }

  const worktreeId = state.activeWorktreeId
  const groupId = state.activeGroupIdByWorktree[worktreeId]
  const group =
    state.groupsByWorktree[worktreeId]?.find((candidate) => candidate.id === groupId) ??
    state.groupsByWorktree[worktreeId]?.[0] ??
    null
  if (!group) {
    return null
  }

  const groupTabs = (state.unifiedTabsByWorktree[worktreeId] ?? []).filter(
    (tab) => tab.groupId === group.id
  )
  const tabById = new Map(groupTabs.map((tab) => [tab.id, tab]))
  // Match TabBar reconciliation: stored order is authoritative, but append mounted tabs missing during hydration/drag races.
  const orderedIds = dedupeTabOrder([
    ...group.tabOrder.filter((tabId) => tabById.has(tabId)),
    ...groupTabs.map((tab) => tab.id)
  ])

  return tabById.get(orderedIds[index] ?? '') ?? null
}

export function activateTabNumberShortcut(index: number): boolean {
  const store = useAppStore.getState()
  const target = resolveTabNumberShortcutTarget(store, index)
  if (!target) {
    return false
  }

  const worktreeId = target.worktreeId
  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId)
  store.focusGroup(worktreeId, target.groupId)
  store.activateTab(target.id)

  if (target.contentType === 'terminal') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId,
        tabId: target.entityId,
        environmentId: runtimeEnvironmentId
      })
    }
    store.setActiveTab(target.entityId)
    store.setActiveTabType('terminal', worktreeId)
    focusTerminalTabSurface(target.entityId)
    return true
  }

  if (target.contentType === 'browser') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId,
        tabId: target.id,
        environmentId: runtimeEnvironmentId
      })
    }
    store.setActiveBrowserTab(target.entityId)
    store.setActiveTabType('browser', worktreeId)
    return true
  }

  if (target.contentType === 'simulator') {
    store.setActiveTab(target.id)
    store.setActiveTabType('simulator', worktreeId)
    return true
  }

  store.setActiveFile(target.entityId)
  store.setActiveTabType('editor', worktreeId)
  return true
}

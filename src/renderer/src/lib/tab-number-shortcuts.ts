import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { dedupeTabOrder } from '@/store/slices/tab-group-state'
import type { Tab } from '../../../shared/types'
import {
  activateWebRuntimeSessionTab,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'

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
  // Why: mirror TabBar's reconcile behavior. Stored group tabOrder is the
  // visible left-to-right source, but stale/missing entries can happen during
  // hydration and drag races, so append currently mounted group tabs.
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
  const runtimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(store, worktreeId)
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
    store.setActiveTabType('terminal')
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
    store.setActiveTabType('browser')
    return true
  }

  if (target.contentType === 'simulator') {
    store.setActiveTab(target.id)
    store.setActiveTabType('simulator')
    return true
  }

  store.setActiveFile(target.entityId)
  store.setActiveTabType('editor')
  return true
}

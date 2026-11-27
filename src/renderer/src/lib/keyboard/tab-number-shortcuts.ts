import { focusTerminalTabSurface } from '@/components/terminal-pane/input/focus/focus-terminal-tab-surface'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { dedupeTabOrder } from '../../../../shared/workspace-layout/tab-groups/tab-order'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { activateWebRuntimeSessionTab } from '@/runtime/web-session-tabs-sync/actions/web-runtime-session-tab-lifecycle'
import { isWebRuntimeSessionActive } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { cancelPendingBotThreadOpen } from '@/lib/agent-session/open/bot-thread-open-lifecycle'
import { displayedTabOrder } from '@/components/bots/bot-home-tab-order'
import type { HomeBotLookup } from '@/components/tab-bar/model/pinned-home-tab'

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
  index: number,
  /** Defaults to the bot catalog, as the tab bar reads it. */
  homeBotFor?: HomeBotLookup | null
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
  const storedIds = dedupeTabOrder([
    ...group.tabOrder.filter((tabId) => tabById.has(tabId)),
    ...groupTabs.map((tab) => tab.id)
  ])
  // The tab bar pins a bot's Home first wherever the stored order holds it; digits match what it shows.
  const orderedIds = displayedTabOrder(storedIds, groupTabs, worktreeId, homeBotFor)

  return tabById.get(orderedIds[index] ?? '') ?? null
}

export function activateTabNumberShortcut(index: number): boolean {
  const store = useAppStore.getState()
  const target = resolveTabNumberShortcutTarget(store, index)
  if (!target) {
    return false
  }

  cancelPendingBotThreadOpen()
  const worktreeId = target.worktreeId
  const runtimeEnvironmentId = runtimeEnvironmentIdOrLocalUnlessTwin(store, worktreeId)
  store.focusGroup(worktreeId, target.groupId)
  store.activateTab(target.id)

  if (target.contentType === 'terminal') {
    // Why: a tab-wide focus or host activation picks the first split pane.
    const activeLeafId = store.terminalLayoutsByTabId[target.entityId]?.activeLeafId ?? null
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId,
        tabId: target.entityId,
        environmentId: runtimeEnvironmentId,
        leafId: activeLeafId
      })
    }
    store.setActiveTab(target.entityId)
    store.setActiveTabType('terminal', worktreeId)
    focusTerminalTabSurface(target.entityId, activeLeafId)
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

  if (target.contentType === 'room') {
    store.setActiveTabType('agent-session', worktreeId)
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

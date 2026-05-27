import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { BrowserTab, TabGroup, TerminalTab } from '../../../shared/types'
import { getGroupVisibleTabOrder } from '@/components/tab-bar/group-tab-order'
import {
  getNextTabAcrossAllTypes,
  getNextTabWithinActiveType,
  type TabCycleType,
  type TypeCyclableTab
} from '@/components/terminal/tab-type-cycle'
import type { AppState } from '@/store/types'
import {
  activateWebRuntimeSessionTab,
  createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive
} from '@/runtime/web-runtime-session'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
export {
  isFloatingWorkspacePanelShortcut,
  isFloatingWorkspacePanelShortcutTarget
} from './floating-workspace-shortcut-policy'

type FloatingWorkspaceTerminalStore = Pick<
  AppState,
  'activeGroupIdByWorktree' | 'createTab' | 'activateTab' | 'settings'
>

type FloatingWorkspaceTabSwitchMode = 'same-type' | 'all-types' | 'terminal'

type FloatingWorkspaceTabSwitchStore = Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activateTab'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'setActiveTab'
  | 'settings'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

const FLOATING_WORKSPACE_PANEL_SELECTOR = '[data-floating-terminal-panel]'

function getActiveFloatingWorkspaceGroup(store: FloatingWorkspaceTabSwitchStore): TabGroup | null {
  const groups = store.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  const activeGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  if (activeGroupId) {
    const activeGroup = groups.find((group) => group.id === activeGroupId)
    if (activeGroup) {
      return activeGroup
    }
  }
  return groups.find((group) => group.activeTabId != null) ?? groups[0] ?? null
}

function getFloatingWorkspaceVisibleTabs(
  store: FloatingWorkspaceTabSwitchStore,
  group: TabGroup
): TypeCyclableTab[] {
  const groupTabs = (store.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).filter(
    (tab) => tab.groupId === group.id
  )
  return getGroupVisibleTabOrder(
    group,
    groupTabs,
    new Set((store.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).map((tab) => tab.id)),
    new Set(
      store.openFiles
        .filter((file) => file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID)
        .map((file) => file.id)
    ),
    new Set((store.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).map((tab) => tab.id))
  )
}

function getFloatingWorkspaceActiveEntry(
  visibleTabs: readonly TypeCyclableTab[],
  group: TabGroup
): TypeCyclableTab | null {
  if (group.activeTabId) {
    const active = visibleTabs.find((tab) => tab.tabId === group.activeTabId)
    if (active) {
      return active
    }
  }
  return visibleTabs[0] ?? null
}

function getActiveIdsForFloatingEntry(entry: TypeCyclableTab): {
  activeBrowserTabId: string | null
  activeFileId: string | null
  activeTabId: string | null
  activeTabType: TabCycleType
} {
  return {
    activeBrowserTabId: entry.type === 'browser' ? entry.id : null,
    activeFileId: entry.type === 'editor' ? entry.id : null,
    activeTabId: entry.type === 'terminal' ? entry.id : null,
    activeTabType: entry.type
  }
}

function getFloatingWorkspaceBrowserTab(
  store: FloatingWorkspaceTabSwitchStore,
  browserTabId: string
): BrowserTab | null {
  return (
    (store.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []).find(
      (tab) => tab.id === browserTabId
    ) ?? null
  )
}

function activateFloatingWorkspaceCyclableTab(
  store: FloatingWorkspaceTabSwitchStore,
  next: TypeCyclableTab
): void {
  if (next.tabId) {
    store.activateTab(next.tabId)
  }

  const runtimeEnvironmentId = store.settings?.activeRuntimeEnvironmentId?.trim()
  if (next.type === 'terminal') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        tabId: next.id,
        environmentId: runtimeEnvironmentId
      })
    }
    store.setActiveTab(next.id)
    focusTerminalTabSurface(next.id)
    return
  }

  if (next.type === 'browser') {
    if (isWebRuntimeSessionActive(runtimeEnvironmentId)) {
      void activateWebRuntimeSessionTab({
        worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
        tabId: next.tabId ?? next.id,
        environmentId: runtimeEnvironmentId
      })
    }
    const workspace = getFloatingWorkspaceBrowserTab(store, next.id)
    if (workspace?.activePageId && typeof window !== 'undefined' && window.api?.browser) {
      void window.api.browser.notifyActiveTabChanged({ browserPageId: workspace.activePageId })
    }
  }
}

function getNextFloatingWorkspaceTerminalTab(
  visibleTabs: readonly TypeCyclableTab[],
  active: TypeCyclableTab,
  direction: number
): TypeCyclableTab | null {
  const terminalTabs = visibleTabs.filter((tab) => tab.type === 'terminal')
  if (terminalTabs.length === 0) {
    return null
  }
  const currentIndex = terminalTabs.findIndex((tab) => tab.id === active.id)
  if (terminalTabs.length === 1 && currentIndex === 0 && active.type === 'terminal') {
    return null
  }
  const normalizedCurrentIndex =
    currentIndex === -1 && direction > 0 ? -1 : currentIndex === -1 ? 0 : currentIndex
  return terminalTabs[
    (normalizedCurrentIndex + direction + terminalTabs.length) % terminalTabs.length
  ]
}

export function isFloatingWorkspacePanelVisible(
  doc: Pick<Document, 'querySelector'> = document
): boolean {
  return Boolean(doc.querySelector('[data-floating-terminal-panel][aria-hidden="false"]'))
}

export function isFloatingWorkspacePanelFocused(
  doc: Pick<Document, 'activeElement'> = document
): boolean {
  const active = doc.activeElement
  return active instanceof HTMLElement && active.closest(FLOATING_WORKSPACE_PANEL_SELECTOR) !== null
}

export function isFloatingWorkspaceTerminalInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.closest(FLOATING_WORKSPACE_PANEL_SELECTOR) === null) {
    return false
  }
  return target.classList.contains('xterm-helper-textarea') || target.closest('.xterm') !== null
}

export function shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
  activeView,
  activeWorktreeId,
  floatingTerminalOpen,
  floatingUnifiedTabCount
}: {
  activeView: string
  activeWorktreeId: string | null
  floatingTerminalOpen: boolean
  floatingUnifiedTabCount: number
}): boolean {
  return (
    floatingTerminalOpen &&
    floatingUnifiedTabCount === 0 &&
    activeView === 'terminal' &&
    activeWorktreeId === null
  )
}

export function switchFloatingWorkspaceTab(
  store: FloatingWorkspaceTabSwitchStore,
  direction: number,
  mode: FloatingWorkspaceTabSwitchMode
): boolean {
  const group = getActiveFloatingWorkspaceGroup(store)
  if (!group) {
    return false
  }
  const visibleTabs = getFloatingWorkspaceVisibleTabs(store, group)
  if (visibleTabs.length <= 1) {
    return false
  }
  const active = getFloatingWorkspaceActiveEntry(visibleTabs, group)
  if (!active) {
    return false
  }
  const groupTabIdInNav =
    group.activeTabId && visibleTabs.some((entry) => entry.tabId === group.activeTabId)
      ? group.activeTabId
      : null

  const next =
    mode === 'terminal'
      ? getNextFloatingWorkspaceTerminalTab(visibleTabs, active, direction)
      : mode === 'all-types'
        ? getNextTabAcrossAllTypes({
            tabs: visibleTabs,
            ...getActiveIdsForFloatingEntry(active),
            activeGroupTabId: groupTabIdInNav,
            direction
          })
        : getNextTabWithinActiveType({
            tabs: visibleTabs,
            ...getActiveIdsForFloatingEntry(active),
            activeGroupTabId: groupTabIdInNav,
            direction
          })

  if (!next) {
    return false
  }

  activateFloatingWorkspaceCyclableTab(store, next)
  return true
}

export async function createFloatingWorkspaceTerminalTab(
  store: FloatingWorkspaceTerminalStore,
  shellOverride?: string
): Promise<TerminalTab | null> {
  const targetGroupId = store.activeGroupIdByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
  const runtimeEnvironmentId = store.settings?.activeRuntimeEnvironmentId?.trim()
  if (
    await createWebRuntimeSessionTerminal({
      worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
      environmentId: runtimeEnvironmentId,
      targetGroupId,
      command: shellOverride,
      activate: true,
      selectWorktree: false
    })
  ) {
    return null
  }

  const tab = store.createTab(FLOATING_TERMINAL_WORKTREE_ID, targetGroupId, shellOverride, {
    activate: false
  })
  store.activateTab(tab.id)
  focusTerminalTabSurface(tab.id)
  return tab
}

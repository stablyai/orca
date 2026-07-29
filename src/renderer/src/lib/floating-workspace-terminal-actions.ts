import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { BrowserTab, TabGroup } from '../../../shared/types'
import { getGroupVisibleTabOrder } from '@/components/tab-bar/group-tab-order'
import {
  getNextTabAcrossAllTypes,
  getNextTabWithinActiveType,
  type TabCycleType,
  type TypeCyclableTab
} from '@/components/terminal/tab-type-cycle'
import type { AppState } from '@/store/types'
import { TOGGLE_FLOATING_TERMINAL_EVENT } from './floating-terminal'
import { focusTerminalTabSurface } from './focus-terminal-tab-surface'
import { keybindingMatchesAction, type KeybindingOverrides } from '../../../shared/keybindings'
export {
  createFloatingWorkspaceBrowserTab,
  createFloatingWorkspaceMarkdownTab,
  createFloatingWorkspaceTerminalTab
} from './floating-workspace-tab-creation'
export {
  isFloatingWorkspacePanelShortcut,
  isFloatingWorkspacePanelShortcutTarget,
  matchFloatingWorkspacePanelChord,
  matchFloatingWorkspacePanelShortcut
} from './floating-workspace-shortcut-policy'

type FloatingWorkspaceTabSwitchMode = 'same-type' | 'all-types' | 'terminal'

type FloatingWorkspaceTabSwitchStore = Pick<
  AppState,
  | 'activeGroupIdByWorktree'
  | 'activateTab'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'setActiveTab'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

const FLOATING_WORKSPACE_PANEL_SELECTOR = '[data-floating-terminal-panel]'
const EMPTY_FLOATING_WORKSPACE_PANEL_SELECTOR =
  '[data-floating-terminal-panel][aria-hidden="false"] [data-floating-terminal-empty-state]'

type EmptyFloatingWorkspaceCloseShortcutEvent = Pick<
  KeyboardEvent,
  | 'altKey'
  | 'code'
  | 'ctrlKey'
  | 'key'
  | 'metaKey'
  | 'preventDefault'
  | 'repeat'
  | 'shiftKey'
  | 'stopImmediatePropagation'
  | 'stopPropagation'
>

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

// Live count of visible floating tabs from store state — lets close handlers re-derive "did this
// actually empty the panel?" at the moment the close resolves, instead of trusting a frozen
// pre-close render snapshot that a concurrent create/no-op close can invalidate.
export function countVisibleFloatingWorkspaceItems(store: FloatingWorkspaceTabSwitchStore): number {
  const group = getActiveFloatingWorkspaceGroup(store)
  return group ? getFloatingWorkspaceVisibleTabs(store, group).length : 0
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

// The guest IPC receiver maps a forwarded close's source id back to the live floating browser
// workspace that owns it, so a stale/reordered/closed id is an idempotent no-op. Main forwards the
// guest's *page* id (BrowserManager keys guests by browserPageId), while the panel closes by
// workspace id, so resolve pages → workspace here; a workspace id is accepted too for callers that
// already speak that id space.
export function resolveFloatingWorkspaceBrowserWorkspaceId(
  store: Pick<AppState, 'browserTabsByWorktree' | 'browserPagesByWorkspace'>,
  sourceId: string
): string | null {
  const workspaces = store.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? []
  const pagesByWorkspace = store.browserPagesByWorkspace ?? {}
  for (const workspace of workspaces) {
    if (workspace.id === sourceId) {
      return workspace.id
    }
    if ((pagesByWorkspace[workspace.id] ?? []).some((page) => page.id === sourceId)) {
      return workspace.id
    }
  }
  return null
}

function activateFloatingWorkspaceCyclableTab(
  store: FloatingWorkspaceTabSwitchStore,
  next: TypeCyclableTab
): void {
  if (next.tabId) {
    store.activateTab(next.tabId)
  }

  if (next.type === 'terminal') {
    store.setActiveTab(next.id)
    focusTerminalTabSurface(next.id)
    return
  }

  if (next.type === 'browser') {
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

export function isEmptyFloatingWorkspacePanelVisible(
  doc: Pick<Document, 'querySelector'> | null = typeof document === 'undefined' ? null : document
): boolean {
  return Boolean(doc?.querySelector(EMPTY_FLOATING_WORKSPACE_PANEL_SELECTOR))
}

export function isFloatingWorkspacePanelFocused(
  doc: Pick<Document, 'activeElement'> | null = typeof document === 'undefined' ? null : document
): boolean {
  const active = doc?.activeElement
  return active instanceof HTMLElement && active.closest(FLOATING_WORKSPACE_PANEL_SELECTOR) !== null
}

// Event-target-aware panel membership (vs isFloatingWorkspacePanelFocused which reads only activeElement).
// Used for routing ownership when activeElement is transiently body/null during blur/IME churn (F6/F7).
export function isEventTargetInsideFloatingWorkspacePanel(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.closest(FLOATING_WORKSPACE_PANEL_SELECTOR) !== null
}

export function isFloatingWorkspaceTerminalInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  if (target.closest(FLOATING_WORKSPACE_PANEL_SELECTOR) === null) {
    return false
  }
  return (
    target.classList?.contains('xterm-helper-textarea') === true ||
    target.closest('.xterm') !== null
  )
}

export function shouldMinimizeFloatingWorkspacePanelOnCloseShortcut({
  floatingTerminalOpen,
  floatingVisibleTabCount
}: {
  floatingTerminalOpen: boolean
  floatingVisibleTabCount: number
}): boolean {
  return floatingTerminalOpen && floatingVisibleTabCount === 0
}

export function handleEmptyFloatingWorkspacePanelCloseShortcut(
  event: EmptyFloatingWorkspaceCloseShortcutEvent,
  platform: NodeJS.Platform,
  keybindings?: KeybindingOverrides
): boolean {
  if (
    event.repeat ||
    !isEmptyFloatingWorkspacePanelVisible() ||
    !keybindingMatchesAction('tab.close', event, platform, keybindings, { context: 'app' })
  ) {
    return false
  }

  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  window.dispatchEvent(new Event(TOGGLE_FLOATING_TERMINAL_EVENT))
  return true
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

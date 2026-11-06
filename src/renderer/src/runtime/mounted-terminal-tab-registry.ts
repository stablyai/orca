import {
  activePaneIsCoveredByNativeChat,
  paneIsCoveredByNativeChat
} from '@/components/terminal-pane/native-chat-covered-pane'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { resolveLeafIdForManager } from '@/lib/pane-manager/pane-key-resolution'

export type RegisteredTerminalTab = {
  tabId: string
  worktreeId: string
  getManager: () => PaneManager | null
  getContainer: () => HTMLDivElement | null
  getPtyIdForPane: (paneId: number) => string | null
  getTabWideAgentHintLeafId: () => string | null
}

export type RegisteredTerminalTabKey = string

const registeredTabs = new Map<RegisteredTerminalTabKey, RegisteredTerminalTab>()
const tabRegisteredAt = new Map<RegisteredTerminalTabKey, number>()
const changeListeners = new Set<() => void>()

function notifyMountedTerminalTabsChanged(): void {
  for (const listener of changeListeners) {
    listener()
  }
}

/** Called on mount, unmount, and an explicit leaf focus. */
export function subscribeMountedTerminalTabChanges(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export function registeredTerminalTabKey(
  worktreeId: string,
  tabId: string
): RegisteredTerminalTabKey {
  return `${worktreeId}\0${tabId}`
}

export function mountedTerminalTabEntries(): IterableIterator<
  [RegisteredTerminalTabKey, RegisteredTerminalTab]
> {
  return registeredTabs.entries()
}

export function getMountedTerminalTabRegisteredAt(
  key: RegisteredTerminalTabKey
): number | undefined {
  return tabRegisteredAt.get(key)
}

export function findRegisteredTerminalTab(
  tabId: string,
  worktreeId?: string
): { key: RegisteredTerminalTabKey; tab: RegisteredTerminalTab } | null {
  if (worktreeId !== undefined) {
    const key = registeredTerminalTabKey(worktreeId, tabId)
    const tab = registeredTabs.get(key)
    return tab ? { key, tab } : null
  }

  let match: { key: RegisteredTerminalTabKey; tab: RegisteredTerminalTab } | null = null
  for (const [key, tab] of registeredTabs) {
    if (tab.tabId !== tabId) {
      continue
    }
    // A tab id without its worktree is ambiguous; callers must fail closed.
    if (match) {
      return null
    }
    match = { key, tab }
  }
  return match
}

/** True while the target TerminalPane is mounted (lifecycle effect ran). */
export function hasRegisteredRuntimeTerminalTab(tabId: string, worktreeId?: string): boolean {
  return findRegisteredTerminalTab(tabId, worktreeId) !== null
}

export function registerRuntimeTerminalTab(tab: RegisteredTerminalTab): () => void {
  const key = registeredTerminalTabKey(tab.worktreeId, tab.tabId)
  registeredTabs.set(key, tab)
  tabRegisteredAt.set(key, Date.now())
  notifyMountedTerminalTabsChanged()
  return () => {
    // React can mount a replacement before the old effect cleans up.
    if (registeredTabs.get(key) !== tab) {
      return
    }
    registeredTabs.delete(key)
    tabRegisteredAt.delete(key)
    notifyMountedTerminalTabsChanged()
  }
}

export function focusRuntimeTerminalSurface(
  tabId: string,
  leafId?: string | null,
  worktreeId?: string
): boolean {
  const registered = findRegisteredTerminalTab(tabId, worktreeId)?.tab
  const manager = registered?.getManager()
  if (!manager) {
    return false
  }
  if (!leafId) {
    // Chat portal covers xterm; return handled to preserve composer focus and prevent DOM fallback (focus-terminal-tab-surface.ts).
    if (activePaneIsCoveredByNativeChat(manager)) {
      return true
    }
    const pane = manager.getActivePane()
    if (!pane) {
      return false
    }
    pane.terminal.focus()
    return !!pane.terminal.textarea && document.activeElement === pane.terminal.textarea
  }
  const resolution = resolveLeafIdForManager(tabId, leafId, manager)
  if (resolution.status !== 'resolved') {
    return false
  }
  const requestedPane = manager
    .getPanes()
    .find((candidate) => candidate.id === resolution.numericPaneId)
  // Covered-leaf activation lets chat claim its composer without xterm focus; explicit leaf requests still update active pane.
  manager.setActivePane(resolution.numericPaneId, {
    focus: !paneIsCoveredByNativeChat(requestedPane)
  })
  notifyMountedTerminalTabsChanged()
  return true
}

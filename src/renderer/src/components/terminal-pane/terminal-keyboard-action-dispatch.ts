import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PaneCwdMap } from './resolve-split-cwd'
import type { PtyTransport } from './pty-transport'
import { copyTerminalSelection } from './terminal-selection-copy'
import { splitTerminalPaneWithInheritedCwd } from './terminal-pane-split-with-inherited-cwd'
import {
  markTerminalFollowOutput,
  markTerminalPinnedViewport,
  syncTerminalScrollIntentFromViewport
} from '@/lib/pane-manager/terminal-scroll-intent'
import type { resolveTerminalKeyboardShortcutAction } from './terminal-keyboard-shortcut-matching'

type TerminalShortcutAction = NonNullable<ReturnType<typeof resolveTerminalKeyboardShortcutAction>>

type ActionDispatchContext = {
  tabId: string
  worktreeId: string
  fallbackCwd: string
  expandedPaneIdRef: React.RefObject<number | null>
  setExpandedPane: (paneId: number | null) => void
  restoreExpandedLayout: () => void
  refreshPaneSizes: (focusActive: boolean) => void
  persistLayoutSnapshot: () => void
  toggleExpandPane: (paneId: number) => void
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  onRequestClosePane: (paneId: number) => void
  onClearPaneScrollback: (pane: ManagedPane) => void
  onSetTitle: (paneId: number) => void
  onClearPaneTitle: (paneId: number) => void
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  paneCwdRef: React.RefObject<PaneCwdMap>
  managerRef: React.RefObject<PaneManager | null>
  getKeyboardSplitTelemetrySource: () => 'contextual_tour' | 'keyboard'
  armNativeOnlyShortcut: (event: KeyboardEvent) => void
}

export function dispatchTerminalShortcutAction(
  action: TerminalShortcutAction,
  event: KeyboardEvent,
  manager: PaneManager,
  context: ActionDispatchContext
): void {
  const {
    tabId,
    worktreeId,
    fallbackCwd,
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onRequestClosePane,
    onClearPaneScrollback,
    onSetTitle,
    onClearPaneTitle,
    paneTransportsRef,
    paneCwdRef,
    managerRef,
    getKeyboardSplitTelemetrySource,
    armNativeOnlyShortcut
  } = context

  if (action.type === 'selectAll') {
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (!pane) {
      return
    }
    if (!event.repeat) {
      armNativeOnlyShortcut(event)
      pane.terminal.selectAll()
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    return
  }
  if (event.repeat) {
    return
  }

  if (action.type === 'copySelection') {
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (!pane || !pane.terminal.getSelection()) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    void copyTerminalSelection({
      terminal: pane.terminal,
      writeClipboardText: window.api.ui.writeTerminalClipboardText
    }).catch(() => {})
    return
  }
  if (action.type === 'toggleSearch') {
    event.preventDefault()
    event.stopImmediatePropagation()
    setSearchOpen((prev) => !prev)
    return
  }
  if (action.type === 'clearActivePane') {
    event.preventDefault()
    event.stopImmediatePropagation()
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (pane) {
      onClearPaneScrollback(pane)
    }
    return
  }
  if (action.type === 'scrollViewport') {
    event.preventDefault()
    event.stopImmediatePropagation()
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (!pane) {
      return
    }
    if (action.position === 'top') {
      markTerminalPinnedViewport(pane.terminal)
      pane.terminal.scrollToLine(0)
    } else {
      markTerminalFollowOutput(pane.terminal)
      pane.terminal.scrollToBottom()
    }
    syncTerminalScrollIntentFromViewport(pane.terminal)
    return
  }
  if (action.type === 'focusPane') {
    const panes = manager.getPanes()
    if (panes.length < 2) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    if (expandedPaneIdRef.current !== null) {
      setExpandedPane(null)
      restoreExpandedLayout()
      refreshPaneSizes(true)
      persistLayoutSnapshot()
    }
    const activeId = manager.getActivePane()?.id ?? panes[0].id
    const currentIdx = panes.findIndex((pane) => pane.id === activeId)
    if (currentIdx === -1) {
      return
    }
    const dir = action.direction === 'next' ? 1 : -1
    manager.setActivePane(panes[(currentIdx + dir + panes.length) % panes.length].id, {
      focus: true
    })
    return
  }
  if (action.type === 'equalizePaneSizes') {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (expandedPaneIdRef.current !== null) {
      return
    }
    manager.equalizePaneSizes()
    ;(manager.getActivePane() ?? manager.getPanes()[0])?.terminal.focus()
    return
  }
  if (action.type === 'toggleExpandActivePane') {
    const panes = manager.getPanes()
    if (panes.length < 2) {
      return
    }
    event.preventDefault()
    event.stopImmediatePropagation()
    toggleExpandPane((manager.getActivePane() ?? panes[0]).id)
    return
  }
  if (action.type === 'setTitle') {
    event.preventDefault()
    event.stopImmediatePropagation()
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (pane) {
      onSetTitle(pane.id)
    }
    return
  }
  if (action.type === 'clearPaneTitle') {
    event.preventDefault()
    event.stopImmediatePropagation()
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (pane) {
      onClearPaneTitle(pane.id)
    }
    return
  }
  if (action.type === 'closeActivePane') {
    event.preventDefault()
    event.stopImmediatePropagation()
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (pane) {
      onRequestClosePane(pane.id)
    }
    return
  }
  if (action.type === 'splitActivePane') {
    event.preventDefault()
    event.stopImmediatePropagation()
    if (expandedPaneIdRef.current !== null) {
      setExpandedPane(null)
      restoreExpandedLayout()
      refreshPaneSizes(true)
      persistLayoutSnapshot()
    }
    const pane = manager.getActivePane() ?? manager.getPanes()[0]
    if (!pane) {
      return
    }
    splitTerminalPaneWithInheritedCwd({
      worktreeId,
      tabId,
      manager,
      getManager: () => managerRef.current,
      paneTransports: paneTransportsRef.current,
      paneCwdMap: paneCwdRef.current,
      fallbackCwd,
      pane,
      direction: action.direction,
      source: getKeyboardSplitTelemetrySource()
    })
  }
}

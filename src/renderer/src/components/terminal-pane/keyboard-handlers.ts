import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  // xterm.js focuses a hidden <textarea class="xterm-helper-textarea"> for
  // keyboard input.  That element IS an editable target, but we must NOT
  // suppress terminal shortcuts when the terminal itself is focused.
  if (target.classList.contains('xterm-helper-textarea')) {
    return false
  }

  if (target.isContentEditable) {
    return true
  }

  const editableAncestor = target.closest(
    'input, textarea, select, [contenteditable=""], [contenteditable="true"]'
  )
  return editableAncestor !== null
}

export type SearchState = {
  query: string
  caseSensitive: boolean
  regex: boolean
}

/**
 * Pure decision function for Cmd+G / Cmd+Shift+G search navigation.
 * Returns 'next', 'previous', or null (no match).
 * Extracted so the key-matching logic is testable without DOM dependencies.
 */
export function matchSearchNavigate(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey' | 'altKey'>,
  isMac: boolean,
  searchOpen: boolean,
  searchState: SearchState
): 'next' | 'previous' | null {
  if (e.altKey) {
    return null
  }
  const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
  if (!mod) {
    return null
  }
  if (e.key.toLowerCase() !== 'g') {
    return null
  }
  if (!searchOpen) {
    return null
  }
  if (!searchState.query) {
    return null
  }
  return e.shiftKey ? 'previous' : 'next'
}

type KeyboardHandlersDeps = {
  isActive: boolean
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  expandedPaneIdRef: React.RefObject<number | null>
  setExpandedPane: (paneId: number | null) => void
  restoreExpandedLayout: () => void
  refreshPaneSizes: (focusActive: boolean) => void
  persistLayoutSnapshot: () => void
  toggleExpandPane: (paneId: number) => void
  setSearchOpen: React.Dispatch<React.SetStateAction<boolean>>
  onRequestClosePane: (paneId: number) => void
  searchOpenRef: React.RefObject<boolean>
  searchStateRef: React.RefObject<SearchState>
}

export function useTerminalKeyboardShortcuts({
  isActive,
  managerRef,
  paneTransportsRef,
  expandedPaneIdRef,
  setExpandedPane,
  restoreExpandedLayout,
  refreshPaneSizes,
  persistLayoutSnapshot,
  toggleExpandPane,
  setSearchOpen,
  onRequestClosePane,
  searchOpenRef,
  searchStateRef
}: KeyboardHandlersDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (e: KeyboardEvent): void => {
      const manager = managerRef.current
      if (!manager) {
        return
      }

      // Cmd+G / Cmd+Shift+G navigates terminal search matches even when focus
      // is inside the search input itself, so this check must run before the
      // editable-target guard would otherwise bypass all terminal shortcuts.
      // stopImmediatePropagation prevents App.tsx's Cmd+Shift+G (source-control sidebar) from also firing.
      const direction = matchSearchNavigate(e, isMac, searchOpenRef.current, searchStateRef.current)
      if (direction !== null) {
        if (e.repeat) {
          return
        }
        e.preventDefault()
        e.stopImmediatePropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        const { query, caseSensitive, regex } = searchStateRef.current
        if (direction === 'next') {
          pane.searchAddon.findNext(query, { caseSensitive, regex })
        } else {
          pane.searchAddon.findPrevious(query, { caseSensitive, regex })
        }
        pane.terminal.focus()
        return
      }

      if (isEditableTarget(e.target)) {
        return
      }

      const action = resolveTerminalShortcutAction(e, isMac)
      if (!action) {
        return
      }

      if (action.type === 'sendInput') {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        paneTransportsRef.current.get(pane.id)?.sendInput(action.data)
        return
      }

      if (e.repeat) {
        return
      }

      // Cmd/Ctrl+Shift+C copies terminal selection via Electron clipboard.
      // This ensures Linux terminal copy works consistently.
      if (action.type === 'copySelection') {
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        const selection = pane.terminal.getSelection()
        if (!selection) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        void window.api.ui.writeClipboardText(selection).catch(() => {
          /* ignore clipboard write failures */
        })
        return
      }

      // Keep Cmd+F bound to the terminal search until the app has a real
      // top-level find-in-page flow to fall back to.
      if (action.type === 'toggleSearch') {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen((prev) => !prev)
        return
      }

      // Cmd+K clears active pane screen + scrollback.
      if (action.type === 'clearActivePane') {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (pane) {
          pane.terminal.clear()
        }
        return
      }

      // Cmd+[ / Cmd+] cycles active split pane focus.
      if (action.type === 'focusPane') {
        const panes = manager.getPanes()
        if (panes.length < 2) {
          return
        }
        e.preventDefault()
        e.stopPropagation()

        // Collapse expanded pane before switching
        if (expandedPaneIdRef.current !== null) {
          setExpandedPane(null)
          restoreExpandedLayout()
          refreshPaneSizes(true)
          persistLayoutSnapshot()
        }

        const activeId = manager.getActivePane()?.id ?? panes[0].id
        const currentIdx = panes.findIndex((p) => p.id === activeId)
        if (currentIdx === -1) {
          return
        }

        const dir = action.direction === 'next' ? 1 : -1
        const nextPane = panes[(currentIdx + dir + panes.length) % panes.length]
        manager.setActivePane(nextPane.id, { focus: true })
        return
      }

      // Cmd+Shift+Enter expands/collapses the active pane to full terminal area.
      if (action.type === 'toggleExpandActivePane') {
        const panes = manager.getPanes()
        if (panes.length < 2) {
          return
        }
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? panes[0]
        if (!pane) {
          return
        }
        toggleExpandPane(pane.id)
        return
      }

      // Cmd+W closes the active split pane (or the whole tab when only one
      // pane remains). Always intercepted here so the tab-level handler in
      // Terminal.tsx never closes the entire tab directly — that would kill
      // every pane instead of just the focused one.
      if (action.type === 'closeActivePane') {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        onRequestClosePane(pane.id)
        return
      }

      // Cmd+D / Cmd+Shift+D split the active pane in the focused tab only.
      // Exit expanded mode first so the new split gets proper dimensions
      // (matches Ghostty behavior).
      if (action.type === 'splitActivePane') {
        e.preventDefault()
        e.stopPropagation()
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
        manager.splitPane(pane.id, action.direction)
      }
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [
    isActive,
    managerRef,
    paneTransportsRef,
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onRequestClosePane,
    searchOpenRef,
    searchStateRef
  ])
}

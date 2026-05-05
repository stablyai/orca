import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'
import { resolveTerminalShortcutAction } from './terminal-shortcut-policy'
import type { MacOptionAsAlt } from './terminal-shortcut-policy'
import { resolveSplitCwd, type PaneCwdMap } from './resolve-split-cwd'

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
  paneCwdRef: React.RefObject<PaneCwdMap>
  /** Worktree-root cwd used when OSC 7 and pty.getCwd both fail. */
  fallbackCwd: string
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
  macOptionAsAltRef: React.RefObject<MacOptionAsAlt>
}

export function useTerminalKeyboardShortcuts({
  isActive,
  managerRef,
  paneTransportsRef,
  paneCwdRef,
  fallbackCwd,
  expandedPaneIdRef,
  setExpandedPane,
  restoreExpandedLayout,
  refreshPaneSizes,
  persistLayoutSnapshot,
  toggleExpandPane,
  setSearchOpen,
  onRequestClosePane,
  searchOpenRef,
  searchStateRef,
  macOptionAsAltRef
}: KeyboardHandlersDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')

    // Why: KeyboardEvent.location on a character key (e.g. Period) always
    // reports that key's own position (0 = standard), not which modifier is
    // held. To distinguish left vs right Option, we record the Option key's
    // location from its own keydown event and clear it on keyup.
    let optionKeyLocation = 0
    const onModifierDown = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        optionKeyLocation = e.location
      }
    }
    const onModifierUp = (e: KeyboardEvent): void => {
      if (e.key === 'Alt') {
        optionKeyLocation = 0
      }
    }

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

      const action = resolveTerminalShortcutAction(
        e,
        isMac,
        macOptionAsAltRef.current,
        optionKeyLocation
      )
      if (!action) {
        return
      }

      if (action.type === 'sendInput') {
        e.preventDefault()
        e.stopImmediatePropagation()
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
        e.stopImmediatePropagation()
        void window.api.ui.writeClipboardText(selection).catch(() => {
          /* ignore clipboard write failures */
        })
        return
      }

      // Keep Cmd+F bound to the terminal search until the app has a real
      // top-level find-in-page flow to fall back to.
      if (action.type === 'toggleSearch') {
        e.preventDefault()
        e.stopImmediatePropagation()
        setSearchOpen((prev) => !prev)
        return
      }

      // Cmd+K clears active pane screen + scrollback.
      if (action.type === 'clearActivePane') {
        e.preventDefault()
        e.stopImmediatePropagation()
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
        e.stopImmediatePropagation()

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
        e.stopImmediatePropagation()
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
        e.stopImmediatePropagation()
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
        e.stopImmediatePropagation()
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
        // Split-pane CWD inheritance (docs/ssh-split-pane-inherit-cwd.md):
        // if we have a confirmed live OSC 7 for the source pane, split
        // synchronously to preserve chaining on rapid Cmd+D. Otherwise fall
        // back to an async resolve that queries pty.getCwd.
        const cached = paneCwdRef.current.get(pane.id)
        if (cached?.confirmed && cached.cwd) {
          manager.splitPane(pane.id, action.direction, { cwd: cached.cwd })
          return
        }
        const ptyId = paneTransportsRef.current.get(pane.id)?.getPtyId() ?? null
        const paneIdAtDispatch = pane.id
        const directionAtDispatch = action.direction
        void (async () => {
          const cwd = await resolveSplitCwd({
            paneCwdMap: paneCwdRef.current,
            sourcePaneId: paneIdAtDispatch,
            sourcePtyId: ptyId,
            fallbackCwd
          })
          managerRef.current?.splitPane(paneIdAtDispatch, directionAtDispatch, { cwd })
        })()
      }
    }

    window.addEventListener('keydown', onModifierDown, { capture: true })
    window.addEventListener('keyup', onModifierUp, { capture: true })
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => {
      window.removeEventListener('keydown', onModifierDown, { capture: true })
      window.removeEventListener('keyup', onModifierUp, { capture: true })
      window.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [
    isActive,
    managerRef,
    paneTransportsRef,
    paneCwdRef,
    fallbackCwd,
    expandedPaneIdRef,
    setExpandedPane,
    restoreExpandedLayout,
    refreshPaneSizes,
    persistLayoutSnapshot,
    toggleExpandPane,
    setSearchOpen,
    onRequestClosePane,
    searchOpenRef,
    searchStateRef,
    macOptionAsAltRef
  ])
}

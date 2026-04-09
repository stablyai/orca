import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'

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
  onRequestClosePane
}: KeyboardHandlersDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }

    const isMac = navigator.userAgent.includes('Mac')
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) {
        return
      }
      if (isEditableTarget(e.target)) {
        return
      }
      const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      if (!mod || e.altKey) {
        return
      }

      const manager = managerRef.current
      if (!manager) {
        return
      }

      // Cmd/Ctrl+Shift+C copies terminal selection via Electron clipboard.
      // This ensures Linux terminal copy works consistently.
      if (e.shiftKey && e.key.toLowerCase() === 'c') {
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
      if (!e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setSearchOpen((prev) => !prev)
        return
      }

      // Cmd+K clears active pane screen + scrollback.
      if (!e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (pane) {
          pane.terminal.clear()
        }
        return
      }

      // Cmd+[ / Cmd+] cycles active split pane focus.
      if (!e.shiftKey && (e.code === 'BracketLeft' || e.code === 'BracketRight')) {
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

        const dir = e.code === 'BracketRight' ? 1 : -1
        const nextPane = panes[(currentIdx + dir + panes.length) % panes.length]
        manager.setActivePane(nextPane.id, { focus: true })
        return
      }

      // Cmd+Shift+Enter expands/collapses the active pane to full terminal area.
      if (e.shiftKey && e.key === 'Enter' && (e.code === 'Enter' || e.code === 'NumpadEnter')) {
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
      if (!e.shiftKey && e.key.toLowerCase() === 'w') {
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
      if (e.key.toLowerCase() === 'd') {
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
        manager.splitPane(pane.id, e.shiftKey ? 'horizontal' : 'vertical')
      }
    }

    // Shift+Enter → send CSI 13;2 u (Kitty keyboard protocol) to PTY so
    // CLI apps like Claude Code can distinguish it from plain Enter and
    // insert a newline.  xterm.js sends bare \r for both by default, and
    // its attachCustomKeyEventHandler doesn't call preventDefault, so the
    // browser still fires keypress and xterm processes it.  Intercepting
    // here in the capture phase with full suppression avoids the double-send.
    const onShiftEnter = (e: KeyboardEvent): void => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) {
        return
      }
      if (e.key !== 'Enter') {
        return
      }
      if (isEditableTarget(e.target)) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      paneTransportsRef.current.get(pane.id)?.sendInput('\x1b[13;2u')
    }

    // Ctrl+Backspace → send \x17 (backward-kill-word) to PTY.
    // Skip when focus is in an input/textarea so native word-delete still works.
    const onCtrlBackspace = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
        return
      }
      if (e.key !== 'Backspace') {
        return
      }
      if (isEditableTarget(e.target)) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      paneTransportsRef.current.get(pane.id)?.sendInput('\x17')
    }

    // Alt+Backspace → send ESC + DEL (\x1b\x7f, backward-kill-word) to PTY.
    // Skip when focus is in an input/textarea so native word-delete still works.
    const onAltBackspace = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) {
        return
      }
      if (e.key !== 'Backspace') {
        return
      }
      if (isEditableTarget(e.target)) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      e.preventDefault()
      e.stopPropagation()
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      paneTransportsRef.current.get(pane.id)?.sendInput('\x1b\x7f')
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keydown', onShiftEnter, { capture: true })
    window.addEventListener('keydown', onCtrlBackspace, { capture: true })
    window.addEventListener('keydown', onAltBackspace, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keydown', onShiftEnter, { capture: true })
      window.removeEventListener('keydown', onCtrlBackspace, { capture: true })
      window.removeEventListener('keydown', onAltBackspace, { capture: true })
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
    onRequestClosePane
  ])
}

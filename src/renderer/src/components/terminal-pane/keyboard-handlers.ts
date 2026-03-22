import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from './pty-transport'

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
  setSearchOpen
}: KeyboardHandlersDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.repeat) {
        return
      }
      if (!e.metaKey || e.altKey || e.ctrlKey) {
        return
      }

      const manager = managerRef.current
      if (!manager) {
        return
      }

      // Cmd+F opens search
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

      // Cmd+W closes only the active split pane and prevents the tab-level
      // handler from closing the entire terminal tab.
      if (!e.shiftKey && e.key.toLowerCase() === 'w') {
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
        manager.closePane(pane.id)
        return
      }

      // Cmd+D / Cmd+Shift+D split the active pane in the focused tab only.
      if (e.key.toLowerCase() === 'd') {
        e.preventDefault()
        e.stopPropagation()
        const pane = manager.getActivePane() ?? manager.getPanes()[0]
        if (!pane) {
          return
        }
        manager.splitPane(pane.id, e.shiftKey ? 'horizontal' : 'vertical')
      }
    }

    // Ctrl+Backspace → send \x17 (backward-kill-word) to PTY.
    const onCtrlBackspace = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
        return
      }
      if (e.key !== 'Backspace') {
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
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput('\x17')
    }

    // Alt+Backspace → send ESC + DEL (\x1b\x7f, backward-kill-word) to PTY.
    const onAltBackspace = (e: KeyboardEvent): void => {
      if (!e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) {
        return
      }
      if (e.key !== 'Backspace') {
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
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput('\x1b\x7f')
    }

    // Shift+Enter → insert a literal newline into the shell command line.
    const onShiftEnter = (e: KeyboardEvent): void => {
      if (!e.shiftKey || e.metaKey || e.altKey || e.ctrlKey) {
        return
      }
      if (e.key !== 'Enter') {
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
      const transport = paneTransportsRef.current.get(pane.id)
      transport?.sendInput('\x16\x0a')
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    window.addEventListener('keydown', onCtrlBackspace, { capture: true })
    window.addEventListener('keydown', onAltBackspace, { capture: true })
    window.addEventListener('keydown', onShiftEnter, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true })
      window.removeEventListener('keydown', onCtrlBackspace, { capture: true })
      window.removeEventListener('keydown', onAltBackspace, { capture: true })
      window.removeEventListener('keydown', onShiftEnter, { capture: true })
    }
  }, [isActive])
}

type FontZoomDeps = {
  isActive: boolean
  managerRef: React.RefObject<PaneManager | null>
  paneFontSizesRef: React.RefObject<Map<number, number>>
  settingsRef: React.RefObject<{ terminalFontSize?: number } | null>
}

export function useTerminalFontZoom({
  isActive,
  managerRef,
  paneFontSizesRef,
  settingsRef
}: FontZoomDeps): void {
  useEffect(() => {
    if (!isActive) {
      return
    }
    const MIN_FONT_SIZE = 8
    const MAX_FONT_SIZE = 32
    const FONT_SIZE_STEP = 1

    return window.api.ui.onTerminalZoom((direction) => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane()
      if (!pane) {
        return
      }

      const globalSize = settingsRef.current?.terminalFontSize ?? 14
      const currentSize = paneFontSizesRef.current.get(pane.id) ?? globalSize

      let nextSize: number
      if (direction === 'reset') {
        nextSize = globalSize
        paneFontSizesRef.current.delete(pane.id)
      } else if (direction === 'in') {
        nextSize = Math.min(MAX_FONT_SIZE, currentSize + FONT_SIZE_STEP)
        paneFontSizesRef.current.set(pane.id, nextSize)
      } else {
        nextSize = Math.max(MIN_FONT_SIZE, currentSize - FONT_SIZE_STEP)
        paneFontSizesRef.current.set(pane.id, nextSize)
      }

      pane.terminal.options.fontSize = nextSize
      try {
        pane.fitAddon.fit()
      } catch {
        /* ignore */
      }
    })
  }, [isActive])
}

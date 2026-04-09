import { useEffect, useRef } from 'react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { shellEscapePath } from './pane-helpers'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import type { PtyTransport } from './pty-transport'

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  isActive: boolean
  // Why: in multi-group splits, isVisible controls rendering/display while
  // isActive controls keyboard focus. When not provided, isActive is used.
  isVisible?: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
  pendingWritesRef: React.RefObject<Map<number, string>>
  isActiveRef: React.RefObject<boolean>
  toggleExpandPane: (paneId: number) => void
}

export function useTerminalPaneGlobalEffects({
  tabId,
  isActive,
  isVisible,
  managerRef,
  containerRef,
  paneTransportsRef,
  pendingWritesRef,
  isActiveRef,
  toggleExpandPane
}: UseTerminalPaneGlobalEffectsArgs): void {
  const wasVisibleRef = useRef(false)

  useEffect(() => {
    const effectiveVisible = isVisible ?? isActive
    const manager = managerRef.current
    if (!manager) {
      return
    }
    if (effectiveVisible) {
      manager.resumeRendering()
      for (const [paneId, pendingBuffer] of pendingWritesRef.current.entries()) {
        if (pendingBuffer.length > 0) {
          const pane = manager.getPanes().find((existingPane) => existingPane.id === paneId)
          if (pane) {
            pane.terminal.write(pendingBuffer)
          }
          pendingWritesRef.current.set(paneId, '')
        }
      }
      // Why: fit all visible panes so they fill their container, but only
      // focus the terminal when the pane is the keyboard-active one. This
      // prevents non-focused split groups from stealing xterm focus.
      requestAnimationFrame(() => {
        if (isActive) {
          fitAndFocusPanes(manager)
        } else {
          fitPanes(manager)
        }
      })
    } else if (wasVisibleRef.current) {
      manager.suspendRendering()
    }
    wasVisibleRef.current = effectiveVisible
    isActiveRef.current = isActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isVisible])

  useEffect(() => {
    const onToggleExpand = (event: Event): void => {
      const detail = (event as CustomEvent<{ tabId?: string }>).detail
      if (!detail?.tabId || detail.tabId !== tabId) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const panes = manager.getPanes()
      if (panes.length < 2) {
        return
      }
      const pane = manager.getActivePane() ?? panes[0]
      if (!pane) {
        return
      }
      toggleExpandPane(pane.id)
    }
    window.addEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    return () => window.removeEventListener(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, onToggleExpand)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId])

  useEffect(() => {
    const effectiveVisible = isVisible ?? isActive
    if (!effectiveVisible) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    // Why: ResizeObserver fires on every incremental size change during
    // continuous window resizes or layout animations.  Each fitPanes() call
    // triggers fitAddon.fit() → terminal.resize() which, when the column
    // count changes, reflows the entire scrollback buffer and recalculates
    // the viewport scroll position.  Rapid-fire reflows can leave the
    // viewport at a stale scroll offset, causing the terminal to appear
    // scrolled to the top or to show blank space where scrollback should be.
    // Batching through requestAnimationFrame coalesces bursts into a single
    // reflow per paint frame — the same pattern used by queueResizeAll in
    // use-terminal-pane-lifecycle.ts.
    let rafId: number | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (rafId !== null) {
        return
      }
      rafId = requestAnimationFrame(() => {
        rafId = null
        const manager = managerRef.current
        if (!manager) {
          return
        }
        fitPanes(manager)
      })
    })
    resizeObserver.observe(container)
    return () => {
      resizeObserver.disconnect()
      if (rafId !== null) {
        cancelAnimationFrame(rafId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, isVisible])

  useEffect(() => {
    return window.api.ui.onFileDrop(({ path, target }) => {
      if (!isActiveRef.current || target !== 'terminal') {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      const pane = manager.getActivePane() ?? manager.getPanes()[0]
      if (!pane) {
        return
      }
      const transport = paneTransportsRef.current.get(pane.id)
      if (!transport) {
        return
      }
      // Why: preload consumes native OS drops before React sees them, so the
      // terminal cannot rely on DOM `drop` events for external files. Reusing
      // the active PTY transport preserves the existing CLI behavior for drag-
      // and-drop path insertion instead of opening those files in the editor.
      // Why: the main process sends one IPC event per dropped file, so
      // appending a trailing space keeps multiple paths separated in the
      // terminal input, matching standard drag-and-drop UX conventions.
      transport.sendInput(`${shellEscapePath(path)} `)
    })
  }, [isActiveRef, managerRef, paneTransportsRef])
}

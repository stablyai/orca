import { useEffect, useRef } from 'react'
import { TOGGLE_TERMINAL_PANE_EXPAND_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { shellEscapePath } from './pane-helpers'
import { fitAndFocusPanes, fitPanes } from './pane-helpers'
import type { PtyTransport } from './pty-transport'

type UseTerminalPaneGlobalEffectsArgs = {
  tabId: string
  isActive: boolean
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
  managerRef,
  containerRef,
  paneTransportsRef,
  pendingWritesRef,
  isActiveRef,
  toggleExpandPane
}: UseTerminalPaneGlobalEffectsArgs): void {
  const wasActiveRef = useRef(false)

  useEffect(() => {
    const manager = managerRef.current
    if (!manager) {
      return
    }
    if (isActive) {
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
      requestAnimationFrame(() => fitAndFocusPanes(manager))
    } else if (wasActiveRef.current) {
      manager.suspendRendering()
    }
    wasActiveRef.current = isActive
    isActiveRef.current = isActive
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

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
    if (!isActive) {
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
  }, [isActive])

  useEffect(() => {
    if (!isActive) {
      return
    }

    let restoreTimer: number | null = null
    const restoreGpuRendering = (): void => {
      if (restoreTimer !== null) {
        window.clearTimeout(restoreTimer)
        restoreTimer = null
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      manager.resumeRendering()
      fitPanes(manager)
    }

    const onLayoutTransition = (event: Event): void => {
      const durationMs = Math.max(
        0,
        ((event as CustomEvent<{ durationMs?: number }>).detail?.durationMs ?? 0) + 34
      )
      const manager = managerRef.current
      if (!manager) {
        return
      }
      // Why: xterm's WebGL renderer can briefly clear to the pane background
      // during animated sidebar width changes even though the terminal itself
      // is still alive. Suspending GPU rendering for just the transition window
      // keeps the DOM renderer in charge while the layout is unstable, then we
      // restore WebGL after the animation finishes.
      manager.suspendRendering()
      fitPanes(manager)
      if (restoreTimer !== null) {
        window.clearTimeout(restoreTimer)
      }
      restoreTimer = window.setTimeout(restoreGpuRendering, durationMs)
    }

    window.addEventListener('orca-layout-transition', onLayoutTransition)
    return () => {
      window.removeEventListener('orca-layout-transition', onLayoutTransition)
      if (restoreTimer !== null) {
        window.clearTimeout(restoreTimer)
      }
    }
  }, [isActive, managerRef])

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

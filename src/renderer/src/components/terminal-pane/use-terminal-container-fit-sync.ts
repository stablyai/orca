import { useEffect } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { holdPtyResizesForPaneSubtrees } from '@/lib/pane-manager/pane-pty-resize-hold'
import { beginTerminalContainerResizeSettle } from '@/lib/pane-manager/terminal-container-resize-settle'
import { fitPanes } from './pane-helpers'

type UseTerminalContainerFitSyncArgs = {
  isVisible: boolean
  isSyncFitEnabled: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
}

export const TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS = 150
export const TERMINAL_CONTAINER_RESIZE_MAX_SETTLE_MS = 1000

export function useTerminalContainerFitSync({
  isVisible,
  isSyncFitEnabled,
  managerRef,
  containerRef
}: UseTerminalContainerFitSyncArgs): void {
  // Why: sidebar open/close toggles dispatch SYNC_FIT_PANES_EVENT from a
  // useLayoutEffect (pre-paint, same frame as the width change) so the
  // terminal fits synchronously with the new container size, eliminating the
  // ~16ms "old cols, new container width" flash that a deferred
  // ResizeObserver rAF would otherwise produce. The subsequent per-pane
  // ResizeObserver rAF and the 150ms debounced global fit become no-ops
  // because proposeDimensions() will match current cols/rows (early-return
  // branch in safeFit). Hidden display:none panes cannot be measured
  // accurately, so they skip this global path and refit on visibility resume.
  useEffect(() => {
    if (!isSyncFitEnabled) {
      return
    }
    const onSyncFit = (): void => {
      managerRef.current?.fitAllPanes()
    }
    window.addEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    return () => {
      window.removeEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    }
  }, [isSyncFitEnabled, managerRef])

  useEffect(() => {
    if (!isVisible) {
      return
    }
    const container = containerRef.current
    if (!container) {
      return
    }
    // Why: ResizeObserver fires on every incremental size change during
    // continuous window resizes or layout animations.  Each fitPanes() call
    // triggers fitAddon.fit() -> terminal.resize() which, when the column
    // count changes, reflows the entire scrollback buffer and recalculates
    // the viewport scroll position. On Windows, a single reflow of 10 000
    // scrollback lines can block the renderer for 500 ms-2 s, freezing the
    // UI while a sidebar opens or a window resizes.
    let timerId: ReturnType<typeof setTimeout> | null = null
    let maxSettleTimerId: ReturnType<typeof setTimeout> | null = null
    let releaseResizeSettle: (() => void) | null = null
    let ptyResizeHold: ReturnType<typeof holdPtyResizesForPaneSubtrees> | null = null
    function clearTimer(): void {
      if (timerId !== null) {
        clearTimeout(timerId)
        timerId = null
      }
    }
    function clearMaxSettleTimer(): void {
      if (maxSettleTimerId !== null) {
        clearTimeout(maxSettleTimerId)
        maxSettleTimerId = null
      }
    }
    function armMaxSettleTimer(): void {
      if (maxSettleTimerId !== null) {
        return
      }
      maxSettleTimerId = setTimeout(() => {
        maxSettleTimerId = null
        finishResizeSettle(true)
      }, TERMINAL_CONTAINER_RESIZE_MAX_SETTLE_MS)
    }
    function beginResizeSettle(armMaxTimer = true): void {
      if (!releaseResizeSettle) {
        releaseResizeSettle = beginTerminalContainerResizeSettle()
        ptyResizeHold = holdPtyResizesForPaneSubtrees([container])
      }
      // Why: resize observers can keep firing during a long drag or platform
      // window animation. A hard cap keeps suppression from starving the final
      // xterm fit if the quiet-period debounce never gets a turn.
      if (armMaxTimer) {
        armMaxSettleTimer()
      }
    }
    function releasePendingResizeSettle(flush: boolean): void {
      releaseResizeSettle?.()
      releaseResizeSettle = null
      const hold = ptyResizeHold
      ptyResizeHold = null
      if (!hold) {
        return
      }
      if (flush) {
        hold.flush()
      } else {
        hold.cancel()
      }
    }
    function finishResizeSettle(flush: boolean): void {
      clearTimer()
      clearMaxSettleTimer()
      const hasActiveSettle = releaseResizeSettle !== null || ptyResizeHold !== null
      if (!hasActiveSettle) {
        return
      }
      const manager = managerRef.current
      if (flush && manager) {
        // Why: while the outer terminal container is resizing, per-pane
        // observers skip heavy xterm reflows and PTY resize forwarding is
        // held. Fit once after the drag settles, then flush the final
        // SIGWINCH-sized grid instead of every transient grid.
        try {
          fitPanes(manager)
        } finally {
          releasePendingResizeSettle(true)
        }
        return
      }
      // Why: a transiently unavailable manager should only skip the local fit;
      // the held final PTY grid still needs to reach the backend.
      releasePendingResizeSettle(flush)
    }
    function scheduleFinalResizeSettle(): void {
      beginResizeSettle()
      clearTimer()
      timerId = setTimeout(() => {
        timerId = null
        finishResizeSettle(true)
      }, TERMINAL_CONTAINER_RESIZE_DEBOUNCE_MS)
    }
    const unsubscribeMinimizedChanged = window.api.ui.onMinimizedChanged((isMinimized) => {
      if (isMinimized) {
        // Why: minimized windows can report hidden/intermediate geometry for a
        // long time. Keep fits and PTY resizes held until restore provides a
        // measurable final layout.
        beginResizeSettle(false)
        clearTimer()
        clearMaxSettleTimer()
        return
      }
      scheduleFinalResizeSettle()
    })
    const resizeObserver = new ResizeObserver(() => {
      scheduleFinalResizeSettle()
    })
    resizeObserver.observe(container)
    return () => {
      unsubscribeMinimizedChanged()
      resizeObserver.disconnect()
      clearTimer()
      finishResizeSettle(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible])
}

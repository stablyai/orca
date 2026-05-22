import { useEffect } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { fitPanes } from './pane-helpers'

type UseTerminalContainerFitSyncArgs = {
  isVisible: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function useTerminalContainerFitSync({
  isVisible,
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
  // branch in safeFit). Listener is global (not gated on isVisible/isActive)
  // so background tabs also fit, keeping their scroll position intact for
  // when the user switches back.
  useEffect(() => {
    const onSyncFit = (): void => {
      managerRef.current?.fitAllPanes()
    }
    window.addEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    return () => {
      window.removeEventListener(SYNC_FIT_PANES_EVENT, onSyncFit)
    }
  }, [managerRef])

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
    const RESIZE_DEBOUNCE_MS = 150
    let timerId: ReturnType<typeof setTimeout> | null = null
    const resizeObserver = new ResizeObserver(() => {
      if (timerId !== null) {
        clearTimeout(timerId)
      }
      timerId = setTimeout(() => {
        timerId = null
        const manager = managerRef.current
        if (manager) {
          fitPanes(manager)
        }
      }, RESIZE_DEBOUNCE_MS)
    })
    resizeObserver.observe(container)
    return () => {
      resizeObserver.disconnect()
      if (timerId !== null) {
        clearTimeout(timerId)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible])
}

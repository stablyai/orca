import { useEffect } from 'react'
import { SYNC_FIT_PANES_EVENT } from '@/constants/terminal'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { fitPanes } from './pane-helpers'

type UseTerminalContainerFitSyncArgs = {
  isVisible: boolean
  isSyncFitEnabled: boolean
  managerRef: React.RefObject<PaneManager | null>
  containerRef: React.RefObject<HTMLDivElement | null>
}

export function useTerminalContainerFitSync({
  isVisible,
  isSyncFitEnabled,
  managerRef,
  containerRef
}: UseTerminalContainerFitSyncArgs): void {
  // Fit synchronously with pre-paint sidebar size changes to avoid a one-frame grid flash; hidden panes defer until reveal and later observers no-op on unchanged dimensions.
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
    // Coalesce incremental resize fits: column reflow scans scrollback and can block Windows renderers for seconds.
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
  }, [isVisible, containerRef, managerRef])
}

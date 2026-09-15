import { useLayoutEffect, useRef, useState } from 'react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { requestPaneTuiRepaint } from '@/lib/pane-manager/pane-tui-repaint-request'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { usePrefersReducedMotion } from '@/hooks/usePrefersReducedMotion'

const CONTENT_TRANSITION_MS = 140

export function useTerminalRichInputAnimation({
  open,
  pane
}: {
  open: boolean
  pane: ManagedPane
}): { layoutOpen: boolean } {
  const [layoutOpen, setLayoutOpen] = useState(open)
  const hasMeasuredLayout = useRef(false)
  const prefersReducedMotion = usePrefersReducedMotion()

  useLayoutEffect(() => {
    pane.container.dataset.terminalRichInputMounted = ''
    return () => {
      delete pane.container.dataset.terminalRichInputMounted
    }
  }, [pane])

  useLayoutEffect(() => {
    if (open || prefersReducedMotion) {
      setLayoutOpen(open)
      return
    }
    const timer = window.setTimeout(() => setLayoutOpen(false), CONTENT_TRANSITION_MS)
    return () => window.clearTimeout(timer)
  }, [open, prefersReducedMotion])

  useLayoutEffect(() => {
    if (!hasMeasuredLayout.current) {
      hasMeasuredLayout.current = true
      if (!layoutOpen) {
        return
      }
    }
    if (layoutOpen !== open) {
      return
    }
    // safeFit owns the pre-fit scroll snapshot; a second restoration pipeline
    // can rewind user scrolling performed while the dock is transitioning.
    safeFit(pane)
    const repaintTimer =
      !layoutOpen && pane.terminal.buffer.active.type === 'alternate'
        ? window.setTimeout(
            () =>
              requestPaneTuiRepaint(pane.container, {
                cols: pane.terminal.cols,
                rows: pane.terminal.rows
              }),
            180
          )
        : null
    return () => {
      if (repaintTimer !== null) {
        window.clearTimeout(repaintTimer)
      }
    }
  }, [layoutOpen, open, pane])

  return { layoutOpen }
}

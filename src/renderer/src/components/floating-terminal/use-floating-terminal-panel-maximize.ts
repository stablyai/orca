import { useCallback, useEffect } from 'react'
import { consumeFloatingTerminalOpenMaximizedIntent } from '@/lib/floating-terminal'
import {
  getMaximizedFloatingTerminalBounds,
  resolveFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelCommittedBounds,
  shouldReconcileFloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'
import { persistFloatingTerminalPanelMaximized } from './floating-terminal-panel-view-state'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'

type FloatingTerminalPanelMaximizeInput = Pick<
  FloatingTerminalPanelLocalState,
  | 'bounds'
  | 'maximized'
  | 'setMaximized'
  | 'setBounds'
  | 'restoreBoundsRef'
  | 'committedBoundsRef'
  | 'boundsSourceRef'
  | 'stagedBoundsRef'
  | 'terminalPaneRegistry'
> &
  Pick<FloatingTerminalPanelStoreState, 'tabs'> & { open: boolean }

export function useFloatingTerminalPanelMaximize({
  bounds,
  maximized,
  setMaximized,
  setBounds,
  restoreBoundsRef,
  committedBoundsRef,
  boundsSourceRef,
  stagedBoundsRef,
  terminalPaneRegistry,
  tabs,
  open
}: FloatingTerminalPanelMaximizeInput) {
  const toggleMaximized = useCallback(() => {
    if (maximized) {
      const restoredState = restoreBoundsRef.current ?? {
        committedBounds: committedBoundsRef.current,
        renderedBounds: resolveFloatingTerminalPanelCommittedBounds(committedBoundsRef.current),
        source: boundsSourceRef.current
      }
      restoreBoundsRef.current = null
      boundsSourceRef.current = restoredState.source
      committedBoundsRef.current = restoredState.committedBounds
      const restoredBounds = shouldReconcileFloatingTerminalPanelBounds(restoredState.source)
        ? resolveFloatingTerminalPanelBounds(restoredState.committedBounds, restoredState.source)
        : restoredState.renderedBounds
      stagedBoundsRef.current = null
      setBounds(restoredBounds)
      setMaximized(false)
      persistFloatingTerminalPanelMaximized(false)
      return
    }
    restoreBoundsRef.current = {
      committedBounds: committedBoundsRef.current,
      renderedBounds: bounds,
      source: boundsSourceRef.current
    }
    stagedBoundsRef.current = null
    setBounds(getMaximizedFloatingTerminalBounds())
    setMaximized(true)
    persistFloatingTerminalPanelMaximized(true)
  }, [
    bounds,
    boundsSourceRef,
    committedBoundsRef,
    maximized,
    restoreBoundsRef,
    setBounds,
    setMaximized,
    stagedBoundsRef
  ])

  const maximizePanel = useCallback(() => {
    if (maximized) {
      return
    }
    restoreBoundsRef.current = {
      committedBounds: committedBoundsRef.current,
      renderedBounds: bounds,
      source: boundsSourceRef.current
    }
    stagedBoundsRef.current = null
    setBounds(getMaximizedFloatingTerminalBounds())
    setMaximized(true)
    persistFloatingTerminalPanelMaximized(true)
  }, [
    bounds,
    boundsSourceRef,
    committedBoundsRef,
    maximized,
    restoreBoundsRef,
    setBounds,
    setMaximized,
    stagedBoundsRef
  ])

  useEffect(() => {
    if (open && consumeFloatingTerminalOpenMaximizedIntent()) {
      maximizePanel()
    }
  }, [open, maximizePanel])

  useEffect(() => {
    terminalPaneRegistry.retainOnly(tabs.map((tab) => tab.id))
  }, [tabs, terminalPaneRegistry])

  return { toggleMaximized }
}

export type FloatingTerminalPanelMaximize = ReturnType<typeof useFloatingTerminalPanelMaximize>

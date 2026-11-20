import { useCallback, useEffect } from 'react'
import { consumeFloatingTerminalOpenMaximizedIntent } from '@/components/floating-terminal/workspace/floating-workspace-open-intent'
import {
  getMaximizedFloatingTerminalBounds,
  resolveFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelCommittedBounds,
  shouldReconcileFloatingTerminalPanelBounds
} from './floating-terminal-panel-bounds'
import { getDefaultFloatingTerminalPanelBoundsState } from './floating-terminal-panel-initial-bounds'
import { RESET_FLOATING_TERMINAL_PANEL_LAYOUT_EVENT } from './floating-terminal-panel-layout-reset'
import { persistFloatingTerminalPanelMaximized } from '../state/floating-terminal-panel-view-state'
import type { FloatingTerminalPanelLocalState } from '../state/use-floating-terminal-panel-local-state'

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
  | 'lastPersistedBoundsRef'
> & { open: boolean }

export function useFloatingTerminalPanelMaximize({
  bounds,
  maximized,
  setMaximized,
  setBounds,
  restoreBoundsRef,
  committedBoundsRef,
  boundsSourceRef,
  stagedBoundsRef,
  lastPersistedBoundsRef,
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
    const resetLayout = (): void => {
      restoreBoundsRef.current = null
      stagedBoundsRef.current = null
      lastPersistedBoundsRef.current = null
      const defaults = getDefaultFloatingTerminalPanelBoundsState()
      committedBoundsRef.current = defaults.committedBounds
      boundsSourceRef.current = defaults.source
      setBounds(defaults.renderedBounds)
      setMaximized(false)
    }
    window.addEventListener(RESET_FLOATING_TERMINAL_PANEL_LAYOUT_EVENT, resetLayout)
    return () => window.removeEventListener(RESET_FLOATING_TERMINAL_PANEL_LAYOUT_EVENT, resetLayout)
  }, [
    boundsSourceRef,
    committedBoundsRef,
    lastPersistedBoundsRef,
    restoreBoundsRef,
    setBounds,
    setMaximized,
    stagedBoundsRef
  ])

  return { toggleMaximized }
}

export type FloatingTerminalPanelMaximize = ReturnType<typeof useFloatingTerminalPanelMaximize>

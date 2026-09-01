import { useCallback, useEffect, useLayoutEffect } from 'react'
import {
  anchorFloatingTerminalPanelBounds,
  clampFloatingTerminalBounds,
  getMaximizedFloatingTerminalBounds,
  persistFloatingTerminalPanelBounds,
  resolveFloatingTerminalPanelBounds,
  shouldReconcileFloatingTerminalPanelBounds,
  type FloatingTerminalPanelBounds,
  type FloatingTerminalPanelCommittedBounds
} from './floating-terminal-panel-bounds'
import { areFloatingTerminalPanelCommittedBoundsEqual } from './floating-terminal-panel-initial-bounds'
import type { FloatingTerminalPanelLocalState } from './use-floating-terminal-panel-local-state'
import type { FloatingTerminalPanelStoreState } from './use-floating-terminal-panel-store-state'

type FloatingTerminalPanelGeometryInput = Pick<
  FloatingTerminalPanelLocalState,
  | 'boundsSourceRef'
  | 'committedBoundsRef'
  | 'setBounds'
  | 'maximized'
  | 'stagedBoundsRef'
  | 'lastPersistedBoundsRef'
  | 'setCwd'
  | 'setMarkdownCwd'
> &
  Pick<FloatingTerminalPanelStoreState, 'floatingTerminalCwd'>

export function useFloatingTerminalPanelGeometry({
  boundsSourceRef,
  committedBoundsRef,
  setBounds,
  maximized,
  stagedBoundsRef,
  lastPersistedBoundsRef,
  setCwd,
  setMarkdownCwd,
  floatingTerminalCwd
}: FloatingTerminalPanelGeometryInput) {
  const persistUserBounds = useCallback(
    (nextBounds: FloatingTerminalPanelCommittedBounds): void => {
      if (
        areFloatingTerminalPanelCommittedBoundsEqual(lastPersistedBoundsRef.current, nextBounds)
      ) {
        return
      }
      lastPersistedBoundsRef.current = nextBounds
      persistFloatingTerminalPanelBounds(nextBounds)
    },
    [lastPersistedBoundsRef]
  )

  const previewUserBounds = useCallback(
    (nextBounds: FloatingTerminalPanelBounds): void => {
      const clampedBounds = clampFloatingTerminalBounds(nextBounds)
      stagedBoundsRef.current = clampedBounds
      setBounds(clampedBounds)
    },
    [setBounds, stagedBoundsRef]
  )

  const commitUserBounds = useCallback(
    (nextBounds: FloatingTerminalPanelBounds | null = stagedBoundsRef.current): void => {
      if (!nextBounds) {
        return
      }
      const clampedBounds = clampFloatingTerminalBounds(nextBounds)
      stagedBoundsRef.current = null
      setBounds(clampedBounds)
      const anchoredBounds = anchorFloatingTerminalPanelBounds(clampedBounds)
      if (!anchoredBounds) {
        return
      }
      committedBoundsRef.current = anchoredBounds
      boundsSourceRef.current = 'user'
      persistUserBounds(anchoredBounds)
    },
    [boundsSourceRef, committedBoundsRef, persistUserBounds, setBounds, stagedBoundsRef]
  )

  const reconcileBounds = useCallback((): void => {
    if (maximized) {
      setBounds(getMaximizedFloatingTerminalBounds())
      return
    }
    setBounds((currentBounds) => {
      const source = boundsSourceRef.current
      if (!shouldReconcileFloatingTerminalPanelBounds(source)) {
        return currentBounds
      }
      return resolveFloatingTerminalPanelBounds(committedBoundsRef.current, source)
    })
  }, [boundsSourceRef, committedBoundsRef, maximized, setBounds])

  useLayoutEffect(() => {
    reconcileBounds()
  }, [reconcileBounds])

  useEffect(() => {
    const handleResize = (): void => reconcileBounds()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [reconcileBounds])

  useEffect(() => {
    let cancelled = false
    void window.api.app.getFloatingTerminalCwd({ path: floatingTerminalCwd }).then((nextCwd) => {
      if (!cancelled) {
        setCwd(nextCwd)
      }
    })
    return () => {
      cancelled = true
    }
  }, [floatingTerminalCwd, setCwd])

  useEffect(() => {
    let cancelled = false
    void window.api.app.getFloatingMarkdownDirectory().then((nextMarkdownCwd) => {
      if (!cancelled) {
        setMarkdownCwd(nextMarkdownCwd)
      }
    })
    return () => {
      cancelled = true
    }
  }, [setMarkdownCwd])

  return { previewUserBounds, commitUserBounds }
}

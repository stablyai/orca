import { useCallback, useEffect, useState } from 'react'
import { onDriverChange } from '@/lib/pane-manager/mobile-driver-state'
import { onOverrideChange } from '@/lib/pane-manager/mobile-fit-overrides'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { safeFit } from '@/lib/pane-manager/pane-tree-ops'
import { applyDesktopFitFallbackAfterReplay } from './desktop-fit-fallback'
import { getOverrideAffectedPanes, getPanesNeedingOverrideFit } from './override-affected-panes'
import type { PtyTransport } from './pty-transport'

export type MobileOverlayTickDeps = {
  managerRef: { current: PaneManager | null }
  // Why: the overlay render resolves each pane's pty through this map, so the
  // tick gate must read the same binding to stay behavior-preserving.
  paneTransportsRef: { current: ReadonlyMap<number, Pick<PtyTransport, 'getPtyId'>> }
}

function isPtyMountedInTab(
  transports: ReadonlyMap<number, Pick<PtyTransport, 'getPtyId'>>,
  ptyId: string
): boolean {
  for (const transport of transports.values()) {
    if (transport.getPtyId() === ptyId) {
      return true
    }
  }
  return false
}

/**
 * Re-render this tab's mobile-fit / presence-lock overlays when the pane-manager
 * state maps change, and refit panes the override moved.
 *
 * Both emitters are global listener sets: every event reaches every mounted tab.
 * The pty-affinity check therefore runs *before* the tick, not just before the
 * rAF work — a remote reconnect replays two handle-rotation events per pane, so
 * an ungated tick costs (events x mounted panes) re-renders per network blip.
 */
export function useMobileOverlayTicks({ managerRef, paneTransportsRef }: MobileOverlayTickDeps): {
  refreshMobileOverlays: () => void
} {
  // Why: override state lives in a Map for perf; this counter forces a re-render on override change so the mobile-fit banner toggles.
  const [, setOverrideTick] = useState(0)
  useEffect(() => {
    const pendingFitFrames = new Set<number>()
    const pendingFallbackTimers = new Set<number>()

    const scheduleFitFrame = (callback: () => void): void => {
      const frameId = window.requestAnimationFrame(() => {
        pendingFitFrames.delete(frameId)
        callback()
      })
      pendingFitFrames.add(frameId)
    }

    const scheduleFallbackTimer = (callback: () => void): void => {
      const timerId = window.setTimeout(() => {
        pendingFallbackTimers.delete(timerId)
        callback()
      }, 100)
      pendingFallbackTimers.add(timerId)
    }

    const unsubscribe = onOverrideChange((event) => {
      if (!isPtyMountedInTab(paneTransportsRef.current, event.ptyId)) {
        return
      }
      setOverrideTick((n) => n + 1)
      const manager = managerRef.current
      if (!manager) {
        return
      }
      // Why: pane IDs are per-tab, so resolve the affected PTY through this tab's live transport bindings, not global pane IDs.
      const getAffectedPanes = (): ManagedPane[] =>
        getOverrideAffectedPanes(
          manager.getPanes(),
          (paneId) => paneTransportsRef.current.get(paneId)?.getPtyId(),
          event.ptyId
        )
      if (event.mode === 'mobile-fit' || event.mode === 'remote-desktop-fit') {
        // Why: when mobile drives, xterm must shrink to phone dims or the wide desktop grid garbles the phone-wrapped stream.
        // Why: skip the rAF unless this tab actually has a mis-parked pane.
        const panesNeedingFit = getPanesNeedingOverrideFit(
          getAffectedPanes(),
          event.cols,
          event.rows
        )
        if (panesNeedingFit.length === 0) {
          return
        }
        scheduleFitFrame(() => {
          for (const pane of getPanesNeedingOverrideFit(
            getAffectedPanes(),
            event.cols,
            event.rows
          )) {
            safeFit(pane)
          }
        })
        return
      }
      if (event.mode === 'desktop-fit') {
        // Why: fitAddon.fit() measures the DOM, so run under rAF after layout settles; the timeout is a safety net if fit silently threw.
        const fitAffectedPanes = (): void => {
          for (const pane of getAffectedPanes()) {
            safeFit(pane)
          }
        }
        scheduleFitFrame(fitAffectedPanes)
        // Why: direct-resize fallback if safeFit no-op'd, only while xterm is still at the prior mobile-fit dims; else event.cols/rows is a stale baseline that clobbers the fit.
        scheduleFallbackTimer(() => {
          for (const pane of getAffectedPanes()) {
            // Why: skip 0×0 hidden panes; forcing desktop dims with no DOM geometry leaves a mismatched grid (fallback is only for the visible pane that failed to refit).
            const rect = pane.container.getBoundingClientRect()
            if (rect.width === 0 || rect.height === 0) {
              continue
            }
            applyDesktopFitFallbackAfterReplay(pane, {
              ...event,
              // Why: the timeout/replay queue can outlive this pane binding; never apply old server dims to a replacement PTY.
              shouldApply: () => getAffectedPanes().includes(pane)
            })
          }
        })
      }
    })

    return () => {
      unsubscribe()
      for (const frameId of pendingFitFrames) {
        window.cancelAnimationFrame(frameId)
      }
      pendingFitFrames.clear()
      for (const timerId of pendingFallbackTimers) {
        window.clearTimeout(timerId)
      }
      pendingFallbackTimers.clear()
    }
  }, [managerRef, paneTransportsRef])

  // Why: driver state lives in a Map for perf; this counter re-renders on driver flips so the lock banner toggles. See docs/mobile-presence-lock.md.
  const [, setDriverTick] = useState(0)
  useEffect(
    () =>
      onDriverChange((event) => {
        if (!isPtyMountedInTab(paneTransportsRef.current, event.ptyId)) {
          return
        }
        setDriverTick((n) => n + 1)
      }),
    [paneTransportsRef]
  )

  // Why: a pane whose transport was swapped under a live overlay portal has no
  // pty affinity left to tick it; the reclaim path drops the stale banner itself.
  const refreshMobileOverlays = useCallback((): void => {
    setOverrideTick((n) => n + 1)
  }, [])
  return { refreshMobileOverlays }
}

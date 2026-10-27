import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { recoverVisibleTerminalWindowWake } from './terminal-visibility-resume'
import { repairPaneWebglCanvasDpr } from '@/lib/pane-manager/terminal-canvas-dpr-repair'
import { presentPaneViewport } from '@/lib/pane-manager/pane-webgl-renderer'
import { recordTerminalFreezeBreadcrumb } from './terminal-freeze-breadcrumbs'
import type { IDisposable } from '@xterm/xterm'
import { activePaneIsCoveredByNativeChat } from './native-chat-covered-pane'

type UseTerminalWindowWakeRecoveryArgs = {
  isVisible: boolean
  isChatViewMode: boolean
  managerRef: React.RefObject<PaneManager | null>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
  panePtyBindingsRef?: React.RefObject<Map<number, IDisposable>>
}

type WindowWakePtyBinding = IDisposable & {
  reassertPtySizeAfterWindowWake?: () => void
}

const DPR_RECOVERY_RETRY_FRAMES = 16

export function useTerminalWindowWakeRecovery({
  isVisible,
  isChatViewMode,
  managerRef,
  isActiveRef,
  isVisibleRef,
  panePtyBindingsRef
}: UseTerminalWindowWakeRecoveryArgs): void {
  useEffect(() => {
    if (!isVisible) {
      return
    }
    let wakeRecoveryFrameId: number | null = null
    let dprRecoveryFrameId: number | null = null
    let dprRecoveryFramesRemaining = 0
    let settledClearGlyphAtlases = false
    let observedDevicePixelRatio = window.devicePixelRatio
    const cancelScheduledWakeRecovery = (): void => {
      if (wakeRecoveryFrameId === null || typeof cancelAnimationFrame !== 'function') {
        wakeRecoveryFrameId = null
        return
      }
      cancelAnimationFrame(wakeRecoveryFrameId)
      wakeRecoveryFrameId = null
    }
    const cancelScheduledDprRecovery = (): void => {
      if (dprRecoveryFrameId !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(dprRecoveryFrameId)
      }
      dprRecoveryFrameId = null
      dprRecoveryFramesRemaining = 0
    }
    const reassertPanePtySizes = (): void => {
      for (const binding of panePtyBindingsRef?.current.values() ?? []) {
        // Why: one settled read avoids duplicate SSH RPCs while still detecting a dropped resize.
        const windowWakeBinding = binding as WindowWakePtyBinding
        windowWakeBinding.reassertPtySizeAfterWindowWake?.()
      }
    }
    const recoverVisibleWake = (
      clearGlyphAtlases: boolean,
      source: 'focus' | 'visibilitychange' | 'system-resumed'
    ): void => {
      // Record trigger and atlas-clear evidence for wake diagnosis; source-specific kinds prevent focus/resume coalescing while same-source repeats fold.
      recordTerminalFreezeBreadcrumb(`wake-recovery:${source}`, { clearGlyphAtlases })
      // Focus and visibility often fire together; keep one immediate recovery and one settled RAF pass.
      if (wakeRecoveryFrameId !== null) {
        // A coalesced settled pass may only strengthen: later focus must not cancel a genuine wake’s atlas clear.
        settledClearGlyphAtlases ||= clearGlyphAtlases
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      recoverVisibleTerminalWindowWake({
        manager,
        isActive: isActiveRef.current,
        isChatViewMode: isChatViewMode && activePaneIsCoveredByNativeChat(manager),
        clearGlyphAtlases
      })
      if (typeof requestAnimationFrame !== 'function') {
        reassertPanePtySizes()
        return
      }
      settledClearGlyphAtlases = clearGlyphAtlases
      wakeRecoveryFrameId = requestAnimationFrame(() => {
        wakeRecoveryFrameId = null
        const clearGlyphAtlasesOnSettle = settledClearGlyphAtlases
        settledClearGlyphAtlases = false
        const settledManager = managerRef.current
        if (!settledManager || !isVisibleRef.current) {
          return
        }
        recoverVisibleTerminalWindowWake({
          manager: settledManager,
          isActive: isActiveRef.current,
          isChatViewMode: isChatViewMode && activePaneIsCoveredByNativeChat(settledManager),
          clearGlyphAtlases: clearGlyphAtlasesOnSettle
        })
        reassertPanePtySizes()
      })
    }
    // Frequent refocus atlas clears race xterm page merging; retry WebGL/refit with pane-scoped repaint instead.
    const onFocus = (): void => recoverVisibleWake(false, 'focus')
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        recoverVisibleWake(false, 'visibilitychange')
      }
    }
    // Why: Linux has no window-occlusion tracking, so visibilitychange never
    // fires around system suspend; the main process broadcasts OS resume.
    const onSystemResumed = (): void => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        recoverVisibleWake(true, 'system-resumed')
      }
    }
    const repairVisiblePanesForDpr = (devicePixelRatio: number): boolean => {
      const manager = managerRef.current
      if (!manager || !isVisibleRef.current) {
        return false
      }
      let deferred = false
      for (const pane of manager.getPanes?.() ?? []) {
        const state = repairPaneWebglCanvasDpr(pane)
        deferred ||= state === 'deferred'
        if (state === 'repaired') {
          presentPaneViewport(pane)
        }
      }
      if (!deferred) {
        observedDevicePixelRatio = devicePixelRatio
      }
      return !deferred
    }
    const scheduleDprRecovery = (): void => {
      if (dprRecoveryFrameId !== null || typeof requestAnimationFrame !== 'function') {
        return
      }
      dprRecoveryFramesRemaining = DPR_RECOVERY_RETRY_FRAMES
      const retry = (): void => {
        dprRecoveryFrameId = null
        if (repairVisiblePanesForDpr(window.devicePixelRatio)) {
          dprRecoveryFramesRemaining = 0
          return
        }
        dprRecoveryFramesRemaining -= 1
        if (dprRecoveryFramesRemaining > 0) {
          dprRecoveryFrameId = requestAnimationFrame(retry)
        }
      }
      dprRecoveryFrameId = requestAnimationFrame(retry)
    }
    const onWindowResize = (): void => {
      // Device-pixel-ratio changes emit resize without CSS size changes; xterm’s observer can miss them while hidden.
      const devicePixelRatio = window.devicePixelRatio
      if (devicePixelRatio === observedDevicePixelRatio) {
        return
      }
      if (dprRecoveryFrameId !== null) {
        return
      }
      if (!repairVisiblePanesForDpr(devicePixelRatio)) {
        scheduleDprRecovery()
      }
    }
    window.addEventListener('focus', onFocus)
    window.addEventListener('resize', onWindowResize)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    // Focus-preserving wake emits no focus/visibility event; main’s resume IPC requests full atlas recovery.
    const unsubscribeSystemResumed =
      typeof window.api?.ui?.onSystemResumed === 'function'
        ? window.api.ui.onSystemResumed(onSystemResumed)
        : null
    return () => {
      cancelScheduledWakeRecovery()
      cancelScheduledDprRecovery()
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('resize', onWindowResize)
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      unsubscribeSystemResumed?.()
    }
  }, [isActiveRef, isChatViewMode, isVisible, isVisibleRef, managerRef, panePtyBindingsRef])
}

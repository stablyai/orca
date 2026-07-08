import { useEffect } from 'react'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import { recoverVisibleTerminalWindowWake } from './terminal-visibility-resume'

type UseTerminalWindowWakeRecoveryArgs = {
  isVisible: boolean
  managerRef: React.RefObject<PaneManager | null>
  isActiveRef: React.RefObject<boolean>
  isVisibleRef: React.RefObject<boolean>
}

export function useTerminalWindowWakeRecovery({
  isVisible,
  managerRef,
  isActiveRef,
  isVisibleRef
}: UseTerminalWindowWakeRecoveryArgs): void {
  useEffect(() => {
    if (!isVisible) {
      return
    }
    let wakeRecoveryFrameId: number | null = null
    let settledClearGlyphAtlases = false
    const cancelScheduledWakeRecovery = (): void => {
      if (wakeRecoveryFrameId === null || typeof cancelAnimationFrame !== 'function') {
        wakeRecoveryFrameId = null
        return
      }
      cancelAnimationFrame(wakeRecoveryFrameId)
      wakeRecoveryFrameId = null
    }
    const recoverVisibleWake = (clearGlyphAtlases: boolean): void => {
      // Focus and visibility often fire together; keep one immediate recovery and one settled RAF pass.
      if (wakeRecoveryFrameId !== null) {
        // Why: a pending settled pass may only upgrade in strength — a plain
        // focus that lands after a genuine wake must not skip its atlas clear.
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
        clearGlyphAtlases
      })
      if (typeof requestAnimationFrame !== 'function') {
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
          clearGlyphAtlases: clearGlyphAtlasesOnSettle
        })
      })
    }
    // Why: plain refocus (alt-tab, devtools) is frequent and often lands while
    // an agent streams; wiping the shared glyph atlas then provokes xterm's
    // page-merge race and paints garbled glyphs. Focus recovery keeps the warm
    // atlas: it only retries WebGL attach, refits, and repaints pane-scoped.
    const onFocus = (): void => recoverVisibleWake(false)
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        recoverVisibleWake(true)
      }
    }
    // Why: Linux has no window-occlusion tracking, so visibilitychange never
    // fires around system suspend; the main process broadcasts OS resume.
    const onSystemResumed = (): void => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') {
        recoverVisibleWake(true)
      }
    }
    window.addEventListener('focus', onFocus)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    const unsubscribeSystemResumed =
      typeof window.api?.ui?.onSystemResumed === 'function'
        ? window.api.ui.onSystemResumed(onSystemResumed)
        : null
    return () => {
      cancelScheduledWakeRecovery()
      window.removeEventListener('focus', onFocus)
      if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
      unsubscribeSystemResumed?.()
    }
  }, [isActiveRef, isVisible, isVisibleRef, managerRef])
}

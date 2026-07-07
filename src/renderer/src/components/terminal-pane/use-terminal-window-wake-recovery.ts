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
    const cancelScheduledWakeRecovery = (): void => {
      if (wakeRecoveryFrameId === null || typeof cancelAnimationFrame !== 'function') {
        wakeRecoveryFrameId = null
        return
      }
      cancelAnimationFrame(wakeRecoveryFrameId)
      wakeRecoveryFrameId = null
    }
    const recoverVisibleWake = (): void => {
      // Focus and visibility often fire together; keep one immediate recovery and one settled RAF pass.
      if (wakeRecoveryFrameId !== null) {
        return
      }
      const manager = managerRef.current
      if (!manager) {
        return
      }
      recoverVisibleTerminalWindowWake({
        manager,
        isActive: isActiveRef.current
      })
      if (typeof requestAnimationFrame !== 'function') {
        return
      }
      wakeRecoveryFrameId = requestAnimationFrame(() => {
        wakeRecoveryFrameId = null
        const settledManager = managerRef.current
        if (!settledManager || !isVisibleRef.current) {
          return
        }
        recoverVisibleTerminalWindowWake({
          manager: settledManager,
          isActive: isActiveRef.current
        })
      })
    }
    const onFocus = (): void => recoverVisibleWake()
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
        recoverVisibleWake()
      }
    }
    window.addEventListener('focus', onFocus)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', onVisibilityChange)
    }
    // Why: a focus-preserving display wake fires neither focus nor
    // visibilitychange, so main relays powerMonitor resume over IPC. Same
    // recovery path — it resumes pane rendering and clears the WebGL latch.
    const unsubscribeSystemResumed =
      window.api?.ui.onSystemResumed?.(() => recoverVisibleWake()) ?? null
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

import { useEffect } from 'react'
import { safeFitAndThen } from '@/lib/pane-manager/pane-fit'
import { getFitOverrideForPty } from '@/lib/pane-manager/mobile-fit-overrides'
import { isPtyLocked } from '@/lib/pane-manager/mobile-driver-state'
import type { PaneManager } from '@/lib/pane-manager/pane-manager'
import type { PtyTransport } from '../pty-transport/pty-transport-types'

export function useWebClientTerminalResize({
  isActive,
  isVisible,
  managerRef,
  paneTransportsRef
}: {
  isActive: boolean
  isVisible: boolean
  managerRef: React.RefObject<PaneManager | null>
  paneTransportsRef: React.RefObject<Map<number, PtyTransport>>
}): void {
  useEffect(() => {
    if (
      !(globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__ ||
      !isVisible ||
      !isActive
    ) {
      return
    }
    const cleanupCallbacks: (() => void)[] = []
    const fitAndForward = (): void => {
      const manager = managerRef.current
      if (!manager) {
        return
      }
      for (const pane of manager.getPanes()) {
        safeFitAndThen(pane, 'web-client-pty-resize', () => {
          const transport = paneTransportsRef.current.get(pane.id)
          if (!transport?.isConnected()) {
            return
          }
          const ptyId = transport.getPtyId()
          if (!ptyId || getFitOverrideForPty(ptyId) || isPtyLocked(ptyId)) {
            return
          }
          if (pane.terminal.cols < 8 || pane.terminal.rows < 4) {
            return
          }
          transport.resize(pane.terminal.cols, pane.terminal.rows)
        })
      }
    }
    const scheduleFrame = (): void => {
      const frameId = requestAnimationFrame(fitAndForward)
      cleanupCallbacks.push(() => cancelAnimationFrame(frameId))
    }
    const scheduleTimer = (delayMs: number): void => {
      const timerId = window.setTimeout(fitAndForward, delayMs)
      cleanupCallbacks.push(() => window.clearTimeout(timerId))
    }
    scheduleFrame()
    scheduleTimer(50)
    scheduleTimer(150)
    scheduleTimer(400)
    scheduleTimer(900)
    return () => {
      for (const cleanup of cleanupCallbacks) {
        cleanup()
      }
    }
  }, [isActive, isVisible, managerRef, paneTransportsRef])
}

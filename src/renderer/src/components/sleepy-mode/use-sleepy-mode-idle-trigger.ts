import { useEffect } from 'react'

/** How often the OS input clock is sampled. A screensaver may start this late; that is fine. */
const POLL_MS = 15_000

/**
 * Fires `onIdle` once the OS reports `delayMs` without input. Disabled while `delayMs` is 0
 * (auto-start off) or `suspended` (the scene is already up).
 *
 * Why the OS clock rather than renderer events: browser panes are `<webview>`s in their own
 * process, and xterm and Monaco stop propagation on what they handle, so a listener on the
 * document misses real work and would cover the window mid-use. An unknown idle time (a
 * platform that cannot measure it, or a paired web client) never starts the scene.
 */
export function useSleepyModeIdleTrigger({
  delayMs,
  suspended,
  onIdle
}: {
  delayMs: number
  suspended: boolean
  onIdle: () => void
}): void {
  useEffect(() => {
    if (delayMs <= 0 || suspended) {
      return
    }

    let cancelled = false
    const sample = async (): Promise<void> => {
      const idleSeconds = await window.api.agentAwake.getSystemIdleSeconds().catch(() => null)
      if (cancelled || idleSeconds === null) {
        return
      }
      if (idleSeconds * 1_000 >= delayMs) {
        onIdle()
      }
    }

    const timer = window.setInterval(() => void sample(), Math.min(POLL_MS, delayMs))
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [delayMs, suspended, onIdle])
}

import { useEffect, useState } from 'react'
import { isOrcaWindowForegroundFocused } from '@/attention/orca-window-foreground-focus'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

const POLL_MS = 30_000

/** Orca app memory for the status bar: sampled only while this window is visible and focused. */
export function useStatusBarAppMemory(enabled: boolean): number | null {
  const [bytes, setBytes] = useState<number | null>(null)
  useEffect(() => {
    if (!enabled) {
      setBytes(null)
      return
    }
    let disposed = false
    let sampledAt = -Infinity
    const sample = (): void => {
      if (!isOrcaWindowForegroundFocused()) {
        return
      }
      sampledAt = Date.now()
      void window.api.memory
        .getAppMemoryTotal()
        .then((total) => {
          if (!disposed) {
            setBytes(total)
          }
        })
        .catch(() => {})
    }
    const sampleIfStale = (): void => {
      if (Date.now() - sampledAt >= POLL_MS) {
        sample()
      }
    }
    const uninstall = installWindowVisibilityInterval({ run: sample, intervalMs: POLL_MS })
    window.addEventListener('focus', sampleIfStale)
    return () => {
      disposed = true
      uninstall()
      window.removeEventListener('focus', sampleIfStale)
    }
  }, [enabled])
  return bytes
}

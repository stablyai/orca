import { useEffect, useState } from 'react'
import { isOrcaWindowForegroundFocused } from '@/attention/orca-window-foreground-focus'

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
    let timer: number | null = null
    const sample = (): void => {
      void window.api.memory
        .getAppMemoryTotal()
        .then((total) => {
          if (!disposed) {
            setBytes(total)
          }
        })
        .catch(() => {})
    }
    const stop = (): void => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
    const sync = (): void => {
      if (!isOrcaWindowForegroundFocused()) {
        stop()
        return
      }
      if (timer === null) {
        sample()
        timer = window.setInterval(sample, POLL_MS)
      }
    }
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    return () => {
      disposed = true
      stop()
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    }
  }, [enabled])
  return bytes
}

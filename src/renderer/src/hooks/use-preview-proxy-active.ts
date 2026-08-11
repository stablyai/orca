import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'

/** Whether a preview proxy is serving this runtime's workspace ports. The
 *  setting answers synchronously; the status probe also catches `orca serve
 *  --preview-*`, which drives the listener without ever touching settings. */
export function usePreviewProxyActive(): boolean {
  const configured = useAppStore((s) => s.settings?.previewProxy?.enabled === true)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    let cancelled = false
    const status = window.api?.previewProxy?.status
    if (!status) {
      return
    }
    void status()
      .then((next) => {
        if (!cancelled) {
          setRunning(next?.running === true)
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [configured])

  return configured || running
}

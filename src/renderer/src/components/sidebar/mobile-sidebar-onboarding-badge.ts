import { useCallback, useEffect, useState } from 'react'

const DISMISS_KEY = 'orca.mobile.sidebar-onboarding-dismissed'

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

// Why: surface a one-time "Try it" badge on the Orca Mobile sidebar entry
// for users who haven't paired any device. Clicking the row dismisses it
// permanently, mirroring the once-and-done feel of an inbox unread dot.
export function useMobileSidebarOnboardingBadge(): {
  visible: boolean
  dismiss: () => void
} {
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed())
  const [hasPairedDevice, setHasPairedDevice] = useState<boolean | null>(null)

  useEffect(() => {
    if (dismissed) {
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const result = await window.api.mobile.listDevices()
        if (!cancelled) {
          setHasPairedDevice(result.devices.length > 0)
        }
      } catch {
        if (!cancelled) {
          setHasPairedDevice(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [dismissed])

  const dismiss = useCallback(() => {
    if (dismissed) {
      return
    }
    try {
      window.localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      // Best-effort; if storage is unavailable the badge will reappear next mount.
    }
    setDismissed(true)
  }, [dismissed])

  return {
    visible: !dismissed && hasPairedDevice === false,
    dismiss
  }
}

import { useCallback, useState } from 'react'
import { usePairedMobileDevices } from '../mobile/paired-mobile-devices'

const DISMISS_KEY = 'orca.mobile.sidebar-onboarding-dismissed'

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISS_KEY) === '1'
  } catch {
    return false
  }
}

export function shouldShowMobileSidebarOnboardingBadge(
  enabled: boolean,
  dismissed: boolean
): boolean {
  return enabled && !dismissed
}

// Why: surface a one-time "Try it" badge on the Orca Mobile sidebar entry
// for users who haven't paired any device. Clicking the row dismisses it
// permanently, mirroring the once-and-done feel of an inbox unread dot.
export function useMobileSidebarOnboardingBadge(enabled = true): {
  visible: boolean
  hasPairedDevice: boolean
  dismiss: () => void
} {
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed())
  const mobileDevices = usePairedMobileDevices({ enabled })

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
    visible:
      shouldShowMobileSidebarOnboardingBadge(enabled, dismissed) &&
      mobileDevices.loaded &&
      // Why: a failed load also lands loaded:true with no devices; don't show
      // the onboarding badge until we actually know the device list is empty.
      !mobileDevices.error &&
      !mobileDevices.hasPairedDevice,
    hasPairedDevice: mobileDevices.hasPairedDevice,
    dismiss
  }
}

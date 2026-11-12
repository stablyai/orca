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

// Offer the Mobile badge until the user opens its row; persist dismissal across mounts.
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
      // Failed loads also set loaded with no devices; do not mistake them for an empty list.
      !mobileDevices.error &&
      !mobileDevices.hasPairedDevice,
    hasPairedDevice: mobileDevices.hasPairedDevice,
    dismiss
  }
}

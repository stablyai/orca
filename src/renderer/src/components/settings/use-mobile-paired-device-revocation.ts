import { useCallback } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  getPairedMobileDevicesSnapshot,
  replacePairedMobileDevices
} from '../mobile/paired-mobile-devices'

export function useMobilePairedDeviceRevocation(
  refreshDevices: (options: { force: true }) => Promise<unknown>
): (deviceId: string) => Promise<void> {
  const mountedRef = useMountedRef()
  return useCallback(
    async (deviceId: string) => {
      try {
        const { revoked } = await window.api.mobile.revokeDevice({ deviceId })
        // Resolved false means nothing was removed; do not announce successful revocation.
        if (!revoked) {
          throw new Error('mobile.revokeDevice returned revoked=false')
        }
        try {
          // Re-read authoritative devices because another phone may have paired meanwhile.
          await refreshDevices({ force: true })
        } catch (err) {
          console.error('mobile.listDevices failed after revoke', err)
          const nextDevices = getPairedMobileDevicesSnapshot().filter(
            (d) => d.deviceId !== deviceId
          )
          replacePairedMobileDevices(nextDevices)
        }
        if (mountedRef.current) {
          toast.success(
            translate('auto.components.settings.MobilePane.2e3dd0bc29', 'Device revoked')
          )
        }
      } catch {
        if (mountedRef.current) {
          toast.error(
            translate('auto.components.settings.MobilePane.870e1b5ca5', 'Failed to revoke device')
          )
        }
      }
    },
    [mountedRef, refreshDevices]
  )
}

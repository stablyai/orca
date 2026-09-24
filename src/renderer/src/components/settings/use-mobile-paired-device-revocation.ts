import { useCallback } from 'react'
import { toast } from 'sonner'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import {
  getPairedMobileDevicesSnapshot,
  replacePairedMobileDevices
} from '../mobile/paired-mobile-devices'

/** Revokes one paired phone and re-reads the device list from the source of truth afterwards. */
export function useMobilePairedDeviceRevocation(
  refreshDevices: (options: { force: true }) => Promise<unknown>
): (deviceId: string) => Promise<void> {
  const mountedRef = useMountedRef()
  return useCallback(
    async (deviceId: string) => {
      try {
        const { revoked } = await window.api.mobile.revokeDevice({ deviceId })
        // Why: the backend can resolve revoked=false without removing the device;
        // surface that as an error instead of a false "Device revoked".
        if (!revoked) {
          throw new Error('mobile.revokeDevice returned revoked=false')
        }
        try {
          // Why: the backend may have learned about another phone while Settings
          // was open, so refresh from source-of-truth after mutating it.
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

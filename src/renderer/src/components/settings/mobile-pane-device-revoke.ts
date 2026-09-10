import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import {
  getPairedMobileDevicesSnapshot,
  replacePairedMobileDevices
} from '../mobile/paired-mobile-devices'

export async function revokePairedMobileDevice(args: {
  deviceId: string
  refreshDevices: (opts: { force: true }) => Promise<unknown>
  isMounted: () => boolean
}): Promise<void> {
  const { deviceId } = args
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
      await args.refreshDevices({ force: true })
    } catch (err) {
      console.error('mobile.listDevices failed after revoke', err)
      const nextDevices = getPairedMobileDevicesSnapshot().filter((d) => d.deviceId !== deviceId)
      replacePairedMobileDevices(nextDevices)
    }
    if (args.isMounted()) {
      toast.success(translate('auto.components.settings.MobilePane.2e3dd0bc29', 'Device revoked'))
    }
  } catch {
    if (args.isMounted()) {
      toast.error(
        translate('auto.components.settings.MobilePane.870e1b5ca5', 'Failed to revoke device')
      )
    }
  }
}

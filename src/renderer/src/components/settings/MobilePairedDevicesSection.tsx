import { Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'

export type PairedDevice = {
  deviceId: string
  name: string
  pairedAt: number
  lastSeenAt: number
}

type MobilePairedDevicesSectionProps = {
  devices: PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
}

export function MobilePairedDevicesSection({
  devices,
  hasQrCode,
  onRevokeDevice
}: MobilePairedDevicesSectionProps): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">
        {translate('auto.components.settings.MobilePane.d7ce676270', 'Paired Devices')}
      </h3>
      {devices.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {hasQrCode
            ? translate(
                'auto.components.settings.MobilePane.1592afcc7a',
                'No devices paired yet. Scan the QR code with the Orca mobile app.'
              )
            : translate('auto.components.settings.MobilePane.1b1b70279a', 'No devices paired yet.')}
        </p>
      ) : (
        <div className="space-y-2">
          {devices.map((device) => (
            <div
              key={device.deviceId}
              className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
            >
              <div>
                <div className="text-sm font-medium">{device.name}</div>
                <div className="text-muted-foreground text-xs">
                  {translate('auto.components.settings.MobilePane.254a6d09e4', 'Paired')}
                  {new Date(device.pairedAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onRevokeDevice(device.deviceId)}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {devices.length > 0 && (
        <p className="text-muted-foreground mt-3 text-xs">
          {translate(
            'auto.components.settings.MobilePane.3939fd062c',
            'Revoking a device disconnects it immediately.'
          )}
        </p>
      )}
    </div>
  )
}

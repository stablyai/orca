import { Trash2 } from 'lucide-react'
import { Button } from '../../../ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { PairedMobileDevice } from '../../../mobile/paired-mobile-devices'
import { LegacyEncryptionNotice } from '../../legacy-encryption-notice'

type MobilePairedDevicesSectionProps = {
  devices: readonly PairedMobileDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
}

export function MobilePairedDevicesSection({
  devices,
  hasQrCode,
  onRevokeDevice
}: MobilePairedDevicesSectionProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">
        {t('auto.components.settings.MobilePane.5f539ff331', 'Paired devices')}
      </h3>
      {devices.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {hasQrCode
            ? t(
                'auto.components.settings.MobilePane.1592afcc7a',
                'No devices paired yet. Scan the QR code with the Orca mobile app.'
              )
            : t('auto.components.settings.MobilePane.1b1b70279a', 'No devices paired yet.')}
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
                  {t('auto.components.settings.MobilePane.254a6d09e4', 'Paired')}
                  {new Date(device.pairedAt).toLocaleDateString(intlLocale)}
                </div>
                {device.usesLegacyEncryption ? (
                  <LegacyEncryptionNotice
                    message={t(
                      'auto.components.settings.MobilePane.legacyEncryption',
                      'Uses older encryption. Update the Orca app on this device.'
                    )}
                  />
                ) : device.olderPairingMethod ? (
                  <div className="text-muted-foreground text-xs">
                    {t(
                      'auto.components.settings.MobilePane.olderPairingMethod',
                      'Uses an older pairing method. Update the Orca app on this phone.'
                    )}
                  </div>
                ) : null}
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
          {t(
            'auto.components.settings.MobilePane.3939fd062c',
            'Revoking a device disconnects it immediately.'
          )}
        </p>
      )}
    </div>
  )
}

import { Trash2 } from 'lucide-react'
import { Button } from '../ui/button'
import { translate } from '@/i18n/i18n'
import type { PairedMobileDevice } from '../mobile/paired-mobile-devices'

export type PairedDevice = PairedMobileDevice

// Why: peer "last seen" needs locale-aware relative phrasing (unlike the
// PR-comment util this replaced, which hardcodes English "m/h ago" words).
function formatLastSeenRelativeTime(timestampMs: number, nowMs: number): string {
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  const deltaSeconds = Math.round((timestampMs - nowMs) / 1000)
  const absSeconds = Math.abs(deltaSeconds)
  if (absSeconds < 60) {
    return rtf.format(deltaSeconds, 'second')
  }
  const deltaMinutes = Math.round(deltaSeconds / 60)
  if (absSeconds < 3600) {
    return rtf.format(deltaMinutes, 'minute')
  }
  const deltaHours = Math.round(deltaSeconds / 3600)
  if (absSeconds < 86_400) {
    return rtf.format(deltaHours, 'hour')
  }
  const deltaDays = Math.round(deltaSeconds / 86_400)
  return rtf.format(deltaDays, 'day')
}

type MobilePairedDevicesSectionProps = {
  devices: readonly PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
  // Peer-collab pairs two Orca desktops, not a phone, so the empty state must not say "mobile app".
  variant?: 'mobile' | 'peer'
  // Why: peer-collab only — lets the host tell "connected right now" apart from a stale
  // lastSeenAt, reusing PeerCollabSettingsPane's existing listConnectedClients poll instead
  // of a second one. Unused (and irrelevant) for the mobile variant.
  connectedDeviceIds?: ReadonlySet<string>
  // Why: peer-collab only — slots the grant picker into each row so offline
  // devices can be granted too; grants key off deviceId, not a live connection.
  renderDeviceActions?: (device: PairedDevice) => React.ReactNode
}

export function MobilePairedDevicesSection({
  devices,
  hasQrCode,
  onRevokeDevice,
  variant = 'mobile',
  connectedDeviceIds,
  renderDeviceActions
}: MobilePairedDevicesSectionProps): React.JSX.Element {
  return (
    <div>
      <h3 className="mb-2 text-sm font-medium">
        {translate('auto.components.settings.MobilePane.d7ce676270', 'Paired Devices')}
      </h3>
      {devices.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {hasQrCode
            ? variant === 'peer'
              ? translate(
                  'auto.components.settings.PeerCollabSettingsPane.noDevicesWithCode',
                  'No devices paired yet. Enter the code on the other Orca desktop.'
                )
              : translate(
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
                <div className="text-sm font-medium">
                  {device.name ||
                    (variant === 'peer'
                      ? translate(
                          'auto.components.settings.MobilePairedDevicesSection.unnamedDevice',
                          'Unnamed device'
                        )
                      : device.name)}
                </div>
                <div className="text-muted-foreground text-xs">
                  {translate('auto.components.settings.MobilePane.254a6d09e4', 'Paired')}
                  {new Date(device.pairedAt).toLocaleDateString()}
                </div>
                {variant === 'peer' && (
                  <div className="text-muted-foreground text-xs">
                    {connectedDeviceIds?.has(device.deviceId)
                      ? translate(
                          'auto.components.settings.MobilePairedDevicesSection.connectedNow',
                          'Connected now'
                        )
                      : device.lastSeenAt > 0
                        ? translate(
                            'auto.components.settings.MobilePairedDevicesSection.lastSeen',
                            'Last seen {{time}}',
                            {
                              time: formatLastSeenRelativeTime(device.lastSeenAt, Date.now())
                            }
                          )
                        : null}
                  </div>
                )}
              </div>
              <div className="flex gap-1">
                {renderDeviceActions?.(device)}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onRevokeDevice(device.deviceId)}
                  className="text-destructive hover:text-destructive"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
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

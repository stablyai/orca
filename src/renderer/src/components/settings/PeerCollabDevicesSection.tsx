import { SearchableSetting } from './SearchableSetting'
import { MobilePairedDevicesSection, type PairedDevice } from './MobilePairedDevicesSection'
import { translate } from '@/i18n/i18n'

type PeerCollabDevicesSectionProps = {
  devices: PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
  connectedDeviceIds: ReadonlySet<string>
}

export function PeerCollabDevicesSection({
  devices,
  hasQrCode,
  onRevokeDevice,
  connectedDeviceIds
}: PeerCollabDevicesSectionProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.PeerCollabSettingsPane.devicesTitle',
        'Peer Devices'
      )}
      description={translate(
        'auto.components.settings.PeerCollabSettingsPane.devicesDescription',
        'Orca desktops that have paired with this computer.'
      )}
      keywords={[]}
    >
      <MobilePairedDevicesSection
        devices={devices}
        hasQrCode={hasQrCode}
        onRevokeDevice={onRevokeDevice}
        variant="peer"
        connectedDeviceIds={connectedDeviceIds}
      />
    </SearchableSetting>
  )
}

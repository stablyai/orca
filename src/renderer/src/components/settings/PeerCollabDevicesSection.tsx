import { SearchableSetting } from './SearchableSetting'
import { MobilePairedDevicesSection, type PairedDevice } from './MobilePairedDevicesSection'
import type { ConnectedPeerClient } from './PeerCollabConnectedClientsSection'
import { PeerTerminalGrantMenu, type HostTerminalOption } from './PeerTerminalGrantMenu'
import { translate } from '@/i18n/i18n'

type PeerCollabDevicesSectionProps = {
  devices: PairedDevice[]
  hasQrCode: boolean
  onRevokeDevice: (deviceId: string) => void
  // Why: reuses PeerCollabSettingsPane's already-polled connectedClients both for the
  // "connected now" label and for live grant state, so neither needs its own poll.
  connectedClients: ConnectedPeerClient[]
  // Registry snapshot for devices with no live connection (grants persist per deviceId).
  grantedTerminalsByDeviceId: Readonly<Record<string, string[]>>
  hostTerminals: HostTerminalOption[]
  onSetGrantedTerminals: (deviceId: string, handles: string[]) => void
}

export function PeerCollabDevicesSection({
  devices,
  hasQrCode,
  onRevokeDevice,
  connectedClients,
  grantedTerminalsByDeviceId,
  hostTerminals,
  onSetGrantedTerminals
}: PeerCollabDevicesSectionProps): React.JSX.Element {
  const connectedDeviceIds = new Set(connectedClients.map((client) => client.deviceId))
  // Why: the connected-clients poll refreshes every few seconds while the registry
  // snapshot loads once — prefer the live view so both grant menus always agree.
  const liveGrantsByDeviceId = new Map(
    connectedClients.map((client) => [client.deviceId, client.grantedTerminals])
  )
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
        renderDeviceActions={(device) => (
          <PeerTerminalGrantMenu
            deviceName={
              device.name ||
              translate(
                'auto.components.settings.MobilePairedDevicesSection.unnamedDevice',
                'Unnamed device'
              )
            }
            grantedTerminals={
              liveGrantsByDeviceId.get(device.deviceId) ??
              grantedTerminalsByDeviceId[device.deviceId] ??
              []
            }
            hostTerminals={hostTerminals}
            onSetGrantedTerminals={(handles) => onSetGrantedTerminals(device.deviceId, handles)}
          />
        )}
      />
    </SearchableSetting>
  )
}

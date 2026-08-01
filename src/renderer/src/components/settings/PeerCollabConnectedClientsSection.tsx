import { Unplug } from 'lucide-react'
import { SearchableSetting } from './SearchableSetting'
import { Button } from '../ui/button'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { PeerTerminalGrantMenu, type HostTerminalOption } from './PeerTerminalGrantMenu'

export type ConnectedPeerClient = {
  connectionId: string
  deviceId: string
  name: string
  connectedAt: number
  subscribedTerminals: string[]
  grantedTerminals: string[]
}

export type { HostTerminalOption }

type PeerCollabConnectedClientsSectionProps = {
  exclusiveInputFloor: boolean
  onToggleExclusiveInputFloor: () => void
  connectedClients: ConnectedPeerClient[]
  onDisconnectClient: (deviceId: string) => void
  hostTerminals: HostTerminalOption[]
  onSetGrantedTerminals: (deviceId: string, handles: string[]) => void
}

export function PeerCollabConnectedClientsSection({
  exclusiveInputFloor,
  onToggleExclusiveInputFloor,
  connectedClients,
  onDisconnectClient,
  hostTerminals,
  onSetGrantedTerminals
}: PeerCollabConnectedClientsSectionProps): React.JSX.Element {
  return (
    <SearchableSetting
      title={translate(
        'auto.components.settings.PeerCollabSettingsPane.connectedTitle',
        'Connected Clients'
      )}
      description={translate(
        'auto.components.settings.PeerCollabSettingsPane.connectedDescription',
        'Orca desktops currently viewing your terminals.'
      )}
      keywords={[]}
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.PeerCollabSettingsPane.exclusiveInputFloorLabel',
          'Block others while someone is typing'
        )}
        description={translate(
          'auto.components.settings.PeerCollabSettingsPane.exclusiveInputFloorDescription',
          'By default everyone can type at once. Turn this on so the terminal locks to whoever typed most recently until they stop.'
        )}
        checked={exclusiveInputFloor}
        onChange={onToggleExclusiveInputFloor}
        className="pb-3"
      />
      <div>
        {connectedClients.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.noClients',
              'No peer desktops are connected right now.'
            )}
          </p>
        ) : (
          <div className="space-y-2">
            {connectedClients.map((client) => (
              <div
                key={client.connectionId}
                className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">{client.name}</div>
                  <div className="text-muted-foreground text-xs">
                    {translate(
                      'auto.components.settings.PeerCollabSettingsPane.connectedAt',
                      'Connected'
                    )}{' '}
                    {new Date(client.connectedAt).toLocaleTimeString()}
                    {client.subscribedTerminals.length > 0
                      ? ` · ${translate(
                          'auto.components.settings.PeerCollabSettingsPane.terminalCount',
                          '{{count}} terminal(s)',
                          { count: client.subscribedTerminals.length }
                        )}`
                      : ''}
                  </div>
                </div>
                <div className="flex gap-1">
                  <PeerTerminalGrantMenu
                    deviceName={client.name}
                    grantedTerminals={client.grantedTerminals}
                    hostTerminals={hostTerminals}
                    onSetGrantedTerminals={(handles) =>
                      onSetGrantedTerminals(client.deviceId, handles)
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDisconnectClient(client.deviceId)}
                    title={translate(
                      'auto.components.settings.PeerCollabSettingsPane.disconnect',
                      'Disconnect'
                    )}
                  >
                    <Unplug className="size-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </SearchableSetting>
  )
}

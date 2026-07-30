import { useMemo } from 'react'
import { ShieldCheck, Trash2, Unplug } from 'lucide-react'
import { SearchableSetting } from './SearchableSetting'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'
import { SettingsSwitchRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveTerminalTabTitle } from '../../../../shared/tab-title-resolution'
import type { TerminalTab } from '../../../../shared/types'

export type ConnectedPeerClient = {
  connectionId: string
  deviceId: string
  name: string
  connectedAt: number
  subscribedTerminals: string[]
  grantedTerminals: string[]
}

export type HostTerminalOption = {
  handle: string
  title: string | null
  tabId: string
}

type PeerCollabConnectedClientsSectionProps = {
  exclusiveInputFloor: boolean
  onToggleExclusiveInputFloor: () => void
  connectedClients: ConnectedPeerClient[]
  onDisconnectClient: (deviceId: string, revokeDevice: boolean) => void
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
  const tabsByWorktree = useAppStore((s) => s.tabsByWorktree)
  const generatedTitlesEnabled = useAppStore((s) => s.settings?.tabAutoGenerateTitle === true)

  // Why: the IPC payload only carries the terminal's raw/live title (see
  // peerCollab:listHostTerminals); the tab's actual display name (custom
  // rename, quick-command label, generated title) lives in this store.
  const terminalTabById = useMemo(() => {
    const map = new Map<string, TerminalTab>()
    for (const tabs of Object.values(tabsByWorktree)) {
      for (const tab of tabs) {
        map.set(tab.id, tab)
      }
    }
    return map
  }, [tabsByWorktree])

  function resolveHostTerminalTitle(terminal: HostTerminalOption): string {
    const tab = terminalTabById.get(terminal.tabId)
    const fallback =
      terminal.title ||
      translate(
        'auto.components.settings.PeerCollabSettingsPane.untitledTerminal',
        'Untitled terminal'
      )
    return tab ? resolveTerminalTabTitle(tab, generatedTitlesEnabled, fallback) : fallback
  }

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
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        title={translate(
                          'auto.components.settings.PeerCollabSettingsPane.grantTerminals',
                          'Share terminals'
                        )}
                      >
                        <ShieldCheck className="size-3.5" />
                        {client.grantedTerminals.length > 0
                          ? ` ${client.grantedTerminals.length}`
                          : ''}
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuLabel>
                        {translate(
                          'auto.components.settings.PeerCollabSettingsPane.grantTerminalsLabel',
                          'Terminals shared with {{name}}',
                          { name: client.name }
                        )}
                      </DropdownMenuLabel>
                      {hostTerminals.length === 0 ? (
                        <p className="text-muted-foreground px-2 py-1.5 text-xs">
                          {translate(
                            'auto.components.settings.PeerCollabSettingsPane.noHostTerminalsToGrant',
                            'No terminals available to share.'
                          )}
                        </p>
                      ) : (
                        hostTerminals.map((terminal) => {
                          const granted = client.grantedTerminals.includes(terminal.handle)
                          return (
                            <DropdownMenuCheckboxItem
                              key={terminal.handle}
                              checked={granted}
                              onCheckedChange={(checked) =>
                                onSetGrantedTerminals(
                                  client.deviceId,
                                  checked
                                    ? [...client.grantedTerminals, terminal.handle]
                                    : client.grantedTerminals.filter((h) => h !== terminal.handle)
                                )
                              }
                            >
                              {resolveHostTerminalTitle(terminal)}
                            </DropdownMenuCheckboxItem>
                          )
                        })
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDisconnectClient(client.deviceId, false)}
                    title={translate(
                      'auto.components.settings.PeerCollabSettingsPane.disconnect',
                      'Disconnect'
                    )}
                  >
                    <Unplug className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onDisconnectClient(client.deviceId, true)}
                    className="text-destructive hover:text-destructive"
                    title={translate(
                      'auto.components.settings.PeerCollabSettingsPane.disconnectAndBlock',
                      'Disconnect and revoke device'
                    )}
                  >
                    <Trash2 className="size-3.5" />
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

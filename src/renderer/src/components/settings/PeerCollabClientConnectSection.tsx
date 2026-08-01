import { useState } from 'react'
import { Pencil } from 'lucide-react'
import { SearchableSetting } from './SearchableSetting'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getPeerCollabClientSearchEntry } from './peer-collab-settings-search'
import { translate } from '@/i18n/i18n'
import type { PeerClientStatus, SavedPeerPairing } from '../../../../shared/peer-client-status'
import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'
import type { PeerHostConnection } from '@/components/peer-collab/use-peer-collab-client-connection'

function peerClientStatusLabel(state: PeerClientStatus['state']): string {
  if (state === 'connecting') {
    return translate(
      'auto.components.settings.PeerCollabSettingsPane.clientConnecting',
      'Connecting'
    )
  }
  if (state === 'connected') {
    return translate('auto.components.settings.PeerCollabSettingsPane.clientConnected', 'Connected')
  }
  if (state === 'reconnect-wait') {
    return translate(
      'auto.components.settings.PeerCollabSettingsPane.clientReconnectWait',
      'Reconnecting'
    )
  }
  return translate('auto.components.settings.PeerCollabSettingsPane.clientClosed', 'Not connected')
}

type PeerCollabClientConnectSectionProps = {
  clientEnabled: boolean
  onToggleClientEnabled: () => void
  clientPairingCode: string
  onClientPairingCodeChange: (value: string) => void
  clientDisplayName: string
  onClientDisplayNameChange: (value: string) => void
  clientConnectBusy: boolean
  onConnect: () => void
  hosts: PeerHostConnection[]
  onDisconnectHost: (hostId: string) => void
  onOpenTerminal: (target: RemoteTerminalTarget) => void
  savedPairings: SavedPeerPairing[]
  onConnectSaved: (hostId: string) => void
  onForgetSavedPairing: (hostId: string) => void
  hostNames: Record<string, string>
  onRenameHost: (hostId: string, name: string) => void
}

function SavedHostCard({
  pairing,
  host,
  hostName,
  clientEnabled,
  clientConnectBusy,
  onConnectSaved,
  onDisconnectHost,
  onForgetSavedPairing,
  onOpenTerminal,
  onRenameHost
}: {
  pairing: SavedPeerPairing
  host: PeerHostConnection | undefined
  hostName: string | null
  clientEnabled: boolean
  clientConnectBusy: boolean
  onConnectSaved: (hostId: string) => void
  onDisconnectHost: (hostId: string) => void
  onForgetSavedPairing: (hostId: string) => void
  onOpenTerminal: (target: RemoteTerminalTarget) => void
  onRenameHost: (hostId: string, name: string) => void
}): React.JSX.Element {
  const state = host?.status.state ?? 'closed'
  const rejected = state === 'closed' && host?.status.lastErrorReason === 'unauthorized'
  const busy = state === 'connected' || state === 'connecting'
  const [editingName, setEditingName] = useState<string | null>(null)

  const commitRename = (): void => {
    if (editingName !== null) {
      onRenameHost(pairing.hostId, editingName)
      setEditingName(null)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-border/60 px-3 py-2">
      <div className="flex items-center gap-2">
        {editingName !== null ? (
          <Input
            autoFocus
            value={editingName}
            onChange={(event) => setEditingName(event.target.value)}
            onBlur={commitRename}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                commitRename()
              } else if (event.key === 'Escape') {
                setEditingName(null)
              }
            }}
            placeholder={translate(
              'auto.components.settings.PeerCollabSettingsPane.renameHostPlaceholder',
              'Display name for this host'
            )}
            className="h-6 flex-1 text-xs"
          />
        ) : (
          <span className="flex-1 truncate text-xs text-muted-foreground">
            {hostName ? (
              <>
                <span className="font-medium text-foreground">{hostName}</span>
                <span className="ml-1.5">{pairing.endpoint ?? ''}</span>
              </>
            ) : (
              (pairing.endpoint ?? '?')
            )}
          </span>
        )}
        {editingName === null ? (
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={() => setEditingName(hostName ?? '')}
            aria-label={translate(
              'auto.components.settings.PeerCollabSettingsPane.renameHost',
              'Rename host'
            )}
          >
            <Pencil className="size-3.5" />
          </Button>
        ) : null}
        <Badge variant="outline" className="text-[11px]">
          {peerClientStatusLabel(state)}
        </Badge>
        {busy ? (
          <Button size="sm" variant="outline" onClick={() => onDisconnectHost(pairing.hostId)}>
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientDisconnect',
              'Disconnect'
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => onConnectSaved(pairing.hostId)}
            disabled={clientConnectBusy || !clientEnabled}
          >
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientReconnectSaved',
              'Reconnect'
            )}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onForgetSavedPairing(pairing.hostId)}
          disabled={!clientEnabled}
        >
          {translate('auto.components.settings.PeerCollabSettingsPane.clientForgetHost', 'Remove')}
        </Button>
      </div>
      {rejected ? (
        <p className="text-xs text-destructive">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.clientSavedPairingInvalid',
            'This pairing is no longer valid — the host may have revoked it.'
          )}
        </p>
      ) : null}
      {state === 'reconnect-wait' && host?.status.lastErrorReason ? (
        <p className="text-xs text-destructive">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.clientTransportError',
            'Connection failed: {{reason}}',
            { reason: host.status.lastErrorReason }
          )}
        </p>
      ) : null}
      {state === 'connected' && host ? (
        <div className="space-y-1">
          {host.terminals.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              {translate(
                'auto.components.settings.PeerCollabSettingsPane.clientNoHostTerminalsShared',
                'The host has not shared a terminal with you yet.'
              )}
            </p>
          ) : (
            host.terminals.map((terminal) => {
              const title =
                terminal.title ||
                translate(
                  'auto.components.settings.PeerCollabSettingsPane.clientUntitledTerminal',
                  'Untitled terminal'
                )
              return (
                <div
                  key={terminal.handle}
                  className="flex items-center justify-between rounded-md bg-muted/40 px-2 py-1"
                >
                  <div className="text-xs font-medium">{title}</div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      onOpenTerminal({ hostId: pairing.hostId, handle: terminal.handle, title })
                    }
                  >
                    {translate(
                      'auto.components.settings.PeerCollabSettingsPane.clientOpenTerminal',
                      'Open'
                    )}
                  </Button>
                </div>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}

export function PeerCollabClientConnectSection({
  clientEnabled,
  onToggleClientEnabled,
  clientPairingCode,
  onClientPairingCodeChange,
  clientDisplayName,
  onClientDisplayNameChange,
  clientConnectBusy,
  onConnect,
  hosts,
  onDisconnectHost,
  onOpenTerminal,
  savedPairings,
  onConnectSaved,
  onForgetSavedPairing,
  hostNames,
  onRenameHost
}: PeerCollabClientConnectSectionProps): React.JSX.Element {
  const connectedCount = hosts.filter((host) => host.status.state === 'connected').length

  return (
    <SearchableSetting
      title={getPeerCollabClientSearchEntry().title}
      description={getPeerCollabClientSearchEntry().description}
      keywords={getPeerCollabClientSearchEntry().keywords}
      className="space-y-3"
    >
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.PeerCollabSettingsPane.clientEnabledLabel',
          'Allow connecting to other desktops'
        )}
        description={translate(
          'auto.components.settings.PeerCollabSettingsPane.clientEnabledDescription',
          'Turn this on to connect this desktop to another Orca as a peer client.'
        )}
        checked={clientEnabled}
        onChange={onToggleClientEnabled}
      />

      {connectedCount > 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.clientConnectedCount',
            'Connected to {{count}} host(s)',
            { count: connectedCount }
          )}
        </p>
      ) : null}

      {savedPairings.length > 0 ? (
        <div className="space-y-2">
          {savedPairings.map((pairing) => (
            <SavedHostCard
              key={pairing.hostId}
              pairing={pairing}
              host={hosts.find((host) => host.hostId === pairing.hostId)}
              clientEnabled={clientEnabled}
              clientConnectBusy={clientConnectBusy}
              onConnectSaved={onConnectSaved}
              onDisconnectHost={onDisconnectHost}
              onForgetSavedPairing={onForgetSavedPairing}
              onOpenTerminal={onOpenTerminal}
              hostName={hostNames[pairing.hostId] ?? null}
              onRenameHost={onRenameHost}
            />
          ))}
        </div>
      ) : null}

      <div className="space-y-2 rounded-lg border border-dashed border-border/60 px-3 py-2">
        <p className="text-xs font-medium text-foreground">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.clientAddHostTitle',
            'Add a host'
          )}
        </p>
        <div className="space-y-1">
          <label htmlFor="peer-collab-client-code" className="text-xs font-medium text-foreground">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientCodeLabel',
              'Pairing code'
            )}
          </label>
          <Input
            id="peer-collab-client-code"
            value={clientPairingCode}
            onChange={(event) => onClientPairingCodeChange(event.target.value)}
            placeholder={translate(
              'auto.components.settings.PeerCollabSettingsPane.clientCodePlaceholder',
              'Paste the code from the other Orca desktop'
            )}
            disabled={!clientEnabled}
          />
        </div>

        <div className="space-y-1">
          <label htmlFor="peer-collab-client-name" className="text-xs font-medium text-foreground">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientNameLabel',
              'Your display name'
            )}
          </label>
          <Input
            id="peer-collab-client-name"
            value={clientDisplayName}
            onChange={(event) => onClientDisplayNameChange(event.target.value)}
            disabled={!clientEnabled}
          />
        </div>

        <Button
          size="sm"
          onClick={onConnect}
          disabled={!clientEnabled || clientConnectBusy || !clientPairingCode.trim()}
        >
          {translate('auto.components.settings.PeerCollabSettingsPane.clientConnect', 'Connect')}
        </Button>
      </div>
    </SearchableSetting>
  )
}

import { SearchableSetting } from './SearchableSetting'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Badge } from '../ui/badge'
import { SettingsSwitchRow } from './SettingsFormControls'
import { getPeerCollabClientSearchEntry } from './peer-collab-settings-search'
import { translate } from '@/i18n/i18n'
import type { RuntimeTerminalListResult } from '../../../../shared/runtime-types'
import type { PeerClientStatus, SavedPeerPairing } from '../../../../shared/peer-client-status'
import type { RemoteTerminalTarget } from '@/components/peer-collab/remote-terminal-target'

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
  clientStatus: PeerClientStatus
  clientConnectBusy: boolean
  onConnect: () => void
  onDisconnect: () => void
  hostTerminals: RuntimeTerminalListResult['terminals']
  onOpenTerminal: (target: RemoteTerminalTarget) => void
  savedPairing: SavedPeerPairing | null
  onConnectSaved: () => void
  onForgetSavedPairing: () => void
}

export function PeerCollabClientConnectSection({
  clientEnabled,
  onToggleClientEnabled,
  clientPairingCode,
  onClientPairingCodeChange,
  clientDisplayName,
  onClientDisplayNameChange,
  clientStatus,
  clientConnectBusy,
  onConnect,
  onDisconnect,
  hostTerminals,
  onOpenTerminal,
  savedPairing,
  onConnectSaved,
  onForgetSavedPairing
}: PeerCollabClientConnectSectionProps): React.JSX.Element {
  const clientBusy = clientStatus.state === 'connected' || clientStatus.state === 'connecting'
  const savedPairingRejected =
    clientStatus.state === 'closed' && clientStatus.lastErrorReason === 'unauthorized'
  const hostDisabledHost =
    clientStatus.state === 'closed' && clientStatus.lastErrorReason === 'host_disabled'
  const formDisabled = !clientEnabled || clientBusy

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

      {hostDisabledHost ? (
        <p className="text-xs text-destructive">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.clientHostDisabled',
            'The host turned off sharing, so you were disconnected.'
          )}
        </p>
      ) : null}

      {savedPairing && savedPairingRejected ? (
        <div className="space-y-1 rounded-lg border border-destructive/40 px-3 py-2">
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientSavedPairingInvalid',
              'This pairing is no longer valid — the host may have revoked it.'
            )}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={onForgetSavedPairing}
            disabled={!clientEnabled}
          >
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientForgetHost',
              'Forget this host'
            )}
          </Button>
        </div>
      ) : null}

      {savedPairing && !savedPairingRejected ? (
        <div className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2">
          <span className="flex-1 text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientSavedHost',
              'Saved host: {{endpoint}}',
              { endpoint: savedPairing.endpoint ?? '?' }
            )}
          </span>
          {!clientBusy ? (
            <Button
              size="sm"
              onClick={onConnectSaved}
              disabled={clientConnectBusy || !clientEnabled}
            >
              {translate(
                'auto.components.settings.PeerCollabSettingsPane.clientReconnectSaved',
                'Reconnect'
              )}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="ghost"
            onClick={onForgetSavedPairing}
            disabled={!clientEnabled}
          >
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientForgetHost',
              'Forget this host'
            )}
          </Button>
        </div>
      ) : null}

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
          disabled={formDisabled}
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
          disabled={formDisabled}
        />
      </div>

      <div className="flex items-center gap-2">
        {clientStatus.state === 'connected' || clientStatus.state === 'reconnect-wait' ? (
          <Button size="sm" variant="outline" onClick={onDisconnect}>
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientDisconnect',
              'Disconnect'
            )}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={onConnect}
            disabled={
              !clientEnabled ||
              clientConnectBusy ||
              clientStatus.state === 'connecting' ||
              !clientPairingCode.trim()
            }
          >
            {translate('auto.components.settings.PeerCollabSettingsPane.clientConnect', 'Connect')}
          </Button>
        )}
        <Badge variant="outline" className="text-[11px]">
          {peerClientStatusLabel(clientStatus.state)}
        </Badge>
        {clientStatus.state === 'connected' && clientStatus.endpoint ? (
          <span className="text-muted-foreground text-xs">{clientStatus.endpoint}</span>
        ) : null}
      </div>

      {clientStatus.state === 'closed' &&
      clientStatus.lastErrorReason === 'duplicate_connection' ? (
        <p className="text-xs text-destructive">
          {translate(
            'auto.components.settings.PeerCollabSettingsPane.clientDuplicateConnection',
            'This pairing code is already in use by another Orca. Generate a new code on the host.'
          )}
        </p>
      ) : null}

      {clientStatus.state === 'reconnect-wait' && clientStatus.lastErrorReason ? (
        <div className="space-y-0.5">
          <p className="text-xs text-destructive">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientTransportError',
              'Connection failed: {{reason}}',
              { reason: clientStatus.lastErrorReason }
            )}
          </p>
          {/EHOSTUNREACH|ENETUNREACH/.test(clientStatus.lastErrorReason) ? (
            <p className="text-muted-foreground text-xs">
              {translate(
                'auto.components.settings.PeerCollabSettingsPane.clientLocalNetworkHint',
                'On macOS, allow this app under System Settings → Privacy & Security → Local Network.'
              )}
            </p>
          ) : null}
        </div>
      ) : null}

      {clientStatus.state === 'connected' ? (
        <div className="space-y-1 pt-1">
          <p className="text-xs font-medium text-foreground">
            {translate(
              'auto.components.settings.PeerCollabSettingsPane.clientHostTerminalsTitle',
              'Host terminals'
            )}
          </p>
          {hostTerminals.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              {translate(
                'auto.components.settings.PeerCollabSettingsPane.clientNoHostTerminalsShared',
                'The host has not shared a terminal with you yet.'
              )}
            </p>
          ) : (
            <div className="space-y-2">
              {hostTerminals.map((terminal) => {
                const title =
                  terminal.title ||
                  translate(
                    'auto.components.settings.PeerCollabSettingsPane.clientUntitledTerminal',
                    'Untitled terminal'
                  )
                return (
                  <div
                    key={terminal.handle}
                    className="flex items-center justify-between rounded-lg border border-border/60 px-3 py-2"
                  >
                    <div>
                      <div className="text-sm font-medium">{title}</div>
                      <div className="text-muted-foreground text-xs">{terminal.worktreePath}</div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onOpenTerminal({ handle: terminal.handle, title })}
                    >
                      {translate(
                        'auto.components.settings.PeerCollabSettingsPane.clientOpenTerminal',
                        'Open'
                      )}
                    </Button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      ) : null}
    </SearchableSetting>
  )
}

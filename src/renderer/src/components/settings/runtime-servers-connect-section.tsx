import { Loader2, Plus, RefreshCw } from 'lucide-react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { UpdateCheckOptions } from '../../../../shared/update-status-types'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { getUpdateCheckClickOptions, getUpdateCheckHint } from '@/lib/update-check-click-options'
import { Button } from '../ui/button'
import type { RuntimeHostDetails } from './runtime-environment-host-details'
import { RuntimeHostAccessForm, type RuntimeHostAccessFailure } from './RuntimeHostAccessForm'
import { RuntimeServerRow } from './runtime-server-row'

type RuntimeServersConnectSectionProps = {
  visible: boolean
  environments: PublicKnownRuntimeEnvironment[]
  detailsByEnvironmentId: Record<string, RuntimeHostDetails>
  activeRuntimeEnvironmentId: string | null | undefined
  addServerFormOpen: boolean
  name: string
  pairingCode: string
  addServerFailure: RuntimeHostAccessFailure | null
  isBusy: boolean
  remoteServerUpdates: Map<string, RemoteServerUpdateEntry>
  remoteServerUpdatesChecking: boolean
  remoteServerUpdatesRunning: boolean
  connectingId: string | null
  switchingValue: string | null
  disconnectingId: string | null
  removingId: string | null
  onOpenAddServerForm: () => void
  onCloseAddServerForm: () => void
  onNameChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  onAddEnvironment: (allowLoopback: boolean) => void
  onOpenUpdateDialog: () => void
  refreshRemoteServerUpdates: (options?: UpdateCheckOptions) => Promise<void>
  onConnect: (environment: PublicKnownRuntimeEnvironment) => void
  onDisconnect: (environment: PublicKnownRuntimeEnvironment) => void
  onRemove: (environment: PublicKnownRuntimeEnvironment) => void
}

export function RuntimeServersConnectSection({
  visible,
  environments,
  detailsByEnvironmentId,
  activeRuntimeEnvironmentId,
  addServerFormOpen,
  name,
  pairingCode,
  addServerFailure,
  isBusy,
  remoteServerUpdates,
  remoteServerUpdatesChecking,
  remoteServerUpdatesRunning,
  connectingId,
  switchingValue,
  disconnectingId,
  removingId,
  onOpenAddServerForm,
  onCloseAddServerForm,
  onNameChange,
  onPairingCodeChange,
  onAddEnvironment,
  onOpenUpdateDialog,
  refreshRemoteServerUpdates,
  onConnect,
  onDisconnect,
  onRemove
}: RuntimeServersConnectSectionProps): React.JSX.Element {
  const updateCheckHint = getUpdateCheckHint()
  return (
    <div className={cn('space-y-3', !visible && 'hidden')}>
      <div
        data-settings-section="remote-server-updates"
        className="flex items-center justify-between gap-3"
      >
        <div className="min-w-0 space-y-0.5">
          <div className="text-sm font-medium">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.connectToRemoteServers',
              'Connect to remote servers'
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.connectToRemoteServersHelp',
              'Pair another Orca runtime, then connect or disconnect it here.'
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {environments.length > 0 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              title={updateCheckHint}
              onClick={(event) => {
                onOpenUpdateDialog()
                void refreshRemoteServerUpdates(getUpdateCheckClickOptions(event))
              }}
              disabled={remoteServerUpdatesChecking && remoteServerUpdates.size === 0}
            >
              {remoteServerUpdatesChecking || remoteServerUpdatesRunning ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {remoteServerUpdatesRunning
                ? translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.updatingServers',
                    'Updating servers…'
                  )
                : translate(
                    'auto.components.settings.RuntimeEnvironmentsPane.reviewServerUpdates',
                    'Check for Server Updates'
                  )}
            </Button>
          ) : null}
          {addServerFormOpen ? null : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={onOpenAddServerForm}
              disabled={isBusy}
            >
              <Plus />
              {translate(
                'auto.components.settings.RuntimeEnvironmentsPane.9bee6bbeeb',
                'Add Server'
              )}
            </Button>
          )}
        </div>
      </div>

      {addServerFormOpen ? (
        <RuntimeHostAccessForm
          name={name}
          accessLink={pairingCode}
          busy={isBusy}
          failure={addServerFailure}
          onNameChange={onNameChange}
          onAccessLinkChange={onPairingCodeChange}
          onCancel={onCloseAddServerForm}
          onSubmit={onAddEnvironment}
        />
      ) : null}

      <div className="rounded-lg border border-border/50 bg-card/30">
        {environments.length === 0 ? (
          <div className="px-3 py-4 text-sm text-muted-foreground">
            {translate(
              'auto.components.settings.RuntimeEnvironmentsPane.9a3758d983',
              'No saved servers.'
            )}
          </div>
        ) : (
          <div className="divide-y divide-border/50">
            {environments.map((environment) => (
              <RuntimeServerRow
                key={environment.id}
                environment={environment}
                details={detailsByEnvironmentId[environment.id]}
                isActive={activeRuntimeEnvironmentId === environment.id}
                remoteUpdate={remoteServerUpdates.get(environment.id)}
                remoteServerUpdatesRunning={remoteServerUpdatesRunning}
                connecting={connectingId === environment.id}
                switching={switchingValue === environment.id}
                disconnecting={disconnectingId === environment.id}
                removing={removingId === environment.id}
                isBusy={isBusy}
                onOpenUpdate={onOpenUpdateDialog}
                onConnect={onConnect}
                onDisconnect={onDisconnect}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

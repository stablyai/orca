import { Link2, Server, TerminalSquare } from 'lucide-react'
import type { ComponentProps } from 'react'
import {
  getOrcadSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import type { UpdateCheckOptions } from '../../../../shared/update-status-types'
import { translate } from '@/i18n/i18n'
import { duplicatePairedServerNames } from '@/lib/duplicate-paired-servers'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import { migrationPhaseLabel } from './managed-server-copy'
import { managedServerTitle } from './managed-server-row-parts'
import type { RuntimeHostDetails } from './runtime-environment-host-details'
import { RuntimeServerRow } from './runtime-server-row'
import { ServerListRow } from './runtime-server-list-row'
import type { ManagedServerCatalog } from './use-managed-server-catalog'
import { useManagedServerLifecycle } from './use-managed-server-lifecycle'

type RowProps = ComponentProps<typeof RuntimeServerRow>

function ManagedRuntimeServerRow({
  api,
  onChanged,
  ...props
}: Omit<RowProps, 'managed'> & {
  api: ManagedOrcadPreloadApi
  onChanged: () => void
}): React.JSX.Element {
  const lifecycle = useManagedServerLifecycle({ api, environment: props.environment, onChanged })
  return <RuntimeServerRow {...props} managed={lifecycle} onChanged={onChanged} />
}

type RuntimeServerListProps = {
  environments: PublicKnownRuntimeEnvironment[]
  detailsByEnvironmentId: Record<string, RuntimeHostDetails>
  activeRuntimeEnvironmentId: string | null | undefined
  remoteServerUpdates: Map<string, RemoteServerUpdateEntry>
  remoteServerUpdatesRunning: boolean
  connectingId: string | null
  switchingValue: string | null
  disconnectingId: string | null
  removingId: string | null
  isBusy: boolean
  managedCatalog: ManagedServerCatalog
  onAddServer: () => void
  onInstallServer: () => void
  onOpenUpdate: () => void
  onConnect: (environment: PublicKnownRuntimeEnvironment) => void
  onDisconnect: (environment: PublicKnownRuntimeEnvironment) => void
  onRemove: (environment: PublicKnownRuntimeEnvironment) => void
  onMakeDefault: (environment: PublicKnownRuntimeEnvironment) => void
  onCheckForUpdates: (options: UpdateCheckOptions) => void
  onRecheck: () => void
  rechecking: boolean
  onChanged: () => void
}

/** Every saved server once: paired, managed over SSH, and managed moves still in progress. */
export function RuntimeServerList({
  environments,
  detailsByEnvironmentId,
  activeRuntimeEnvironmentId,
  remoteServerUpdates,
  remoteServerUpdatesRunning,
  connectingId,
  switchingValue,
  disconnectingId,
  removingId,
  isBusy,
  managedCatalog,
  onAddServer,
  onInstallServer,
  onOpenUpdate,
  onConnect,
  onDisconnect,
  onRemove,
  onMakeDefault,
  onCheckForUpdates,
  onRecheck,
  rechecking,
  onChanged
}: RuntimeServerListProps): React.JSX.Element {
  const { api, pending, targets, resumingId, resume, reload } = managedCatalog

  if (environments.length === 0 && pending.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-10 text-center">
        <span className="flex size-10 items-center justify-center rounded-lg bg-accent text-muted-foreground">
          <Server className="size-5" />
        </span>
        <div className="space-y-1">
          <div className="text-sm font-medium">
            {translate('auto.components.settings.serverList.noSavedServers', 'No saved servers')}
          </div>
          <p className="max-w-sm text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.serverList.emptyDescription',
              'Pair a dev box, a cloud machine, or a desktop at home. Its sessions keep running there when this computer sleeps.'
            )}
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" size="sm" onClick={onAddServer}>
            <Link2 />
            {translate('auto.components.settings.serverList.pasteAccessLink', 'Paste access link')}
          </Button>
          {api ? (
            <Button type="button" variant="outline" size="sm" onClick={onInstallServer}>
              <TerminalSquare />
              {translate(
                'auto.components.settings.serverList.setUpOnSshHost',
                'Set up Orca on an SSH host'
              )}
            </Button>
          ) : null}
        </div>
      </div>
    )
  }

  const firstManagedId = environments.find((environment) => getOrcadSshDeployment(environment))?.id
  return (
    <div
      data-settings-section={firstManagedId ? undefined : 'managed-servers'}
      className="divide-y divide-border rounded-lg border border-border bg-card"
    >
      {environments.map((environment) => {
        const rowProps = {
          environment,
          duplicateOfNames: duplicatePairedServerNames(environments, environment.id),
          details: detailsByEnvironmentId[environment.id],
          isActive: activeRuntimeEnvironmentId === environment.id,
          remoteUpdate: remoteServerUpdates.get(environment.id),
          remoteServerUpdatesRunning,
          connecting: connectingId === environment.id,
          switching: switchingValue === environment.id,
          disconnecting: disconnectingId === environment.id,
          removing: removingId === environment.id,
          isBusy,
          sshAccessApi: api ?? null,
          sshTargets: targets,
          onOpenUpdate,
          onConnect,
          onDisconnect,
          onRemove,
          onMakeDefault,
          onCheckForUpdates,
          onRefreshSshTargets: () => void reload().catch(() => {}),
          onRecheck,
          rechecking
        }
        const row =
          api && getOrcadSshDeployment(environment) ? (
            <ManagedRuntimeServerRow {...rowProps} api={api} onChanged={onChanged} />
          ) : (
            <RuntimeServerRow {...rowProps} onChanged={onChanged} />
          )
        // Why the wrapper: deep links to "managed-servers" land on the first managed row.
        return environment.id === firstManagedId ? (
          <div key={environment.id} data-settings-section="managed-servers" className="scroll-mt-8">
            {row}
          </div>
        ) : (
          <div key={environment.id}>{row}</div>
        )
      })}
      {pending.map((row) => (
        <ServerListRow
          key={row.migrationId}
          name={managedServerTitle(
            targets.find((target) => target.id === row.sshTargetId)?.label ?? row.name
          )}
          meta={<span className="truncate">{migrationPhaseLabel(row.phase)}</span>}
          status={{
            label: translate('auto.components.settings.serverList.movePaused', 'Move paused'),
            tone: 'muted'
          }}
          primaryAction={
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={resumingId !== null}
              onClick={() => void resume(row)}
            >
              {resumingId === row.migrationId ? <LoadingSpinner className="size-3" /> : null}
              {translate('auto.components.settings.managedServers.pending.resume', 'Resume')}
            </Button>
          }
        />
      ))}
    </div>
  )
}

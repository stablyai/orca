import { useState } from 'react'
import { Link2 } from 'lucide-react'
import {
  getOrcadSshDeployment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import type { RemoteServerUpdateEntry } from '@/runtime/remote-server-update-coordinator'
import type { UpdateCheckOptions } from '../../../../shared/update-status-types'
import { getRuntimeServerProblemLine, getRuntimeServerRoute } from './runtime-server-row-meta'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import type { RuntimeHostDetails } from './runtime-environment-host-details'
import {
  formatRuntimeEndpointAddress,
  getRuntimeServerAvailableUpdateText,
  getRuntimeServerStatusIndicator,
  getRuntimeServerVersionText,
  isRemoteServerUpdateInFlight
} from './runtime-server-row-presentation'
import { RuntimeRepairDialog } from './RuntimeRepairDialog'
import { RuntimeServerRowDetails } from './runtime-server-row-details'
import { RuntimeServerRowMenuItems } from './runtime-server-row-menu'
import { useRuntimeServerRowState } from './runtime-server-row-state'
import {
  ServerListRow,
  ServerRowChip,
  ServerRowDetailsToggle,
  type ServerRowStatus
} from './runtime-server-list-row'
import { RuntimeSshAccessControl } from './RuntimeSshAccessControl'
import { RuntimeSshAccessDialog } from './runtime-ssh-access-dialog'
import {
  getManagedServerSummary,
  ManagedServerConfirmations,
  ManagedServerDetailLines,
  managedServerHasConfirmation,
  ManagedServerMenuItems,
  managedServerHasPrimaryAction,
  ManagedServerPrimaryAction
} from './managed-server-row-parts'
import type { ManagedServerLifecycle } from './use-managed-server-lifecycle'

const NO_SSH_TARGETS: SshTarget[] = []
const NO_DUPLICATES: readonly string[] = []

type RuntimeServerRowProps = {
  environment: PublicKnownRuntimeEnvironment
  /** Other saved servers with this one's host key: the same machine paired twice. */
  duplicateOfNames?: readonly string[]
  details: RuntimeHostDetails | undefined
  isActive: boolean
  remoteUpdate: RemoteServerUpdateEntry | undefined
  remoteServerUpdatesRunning: boolean
  connecting: boolean
  switching: boolean
  disconnecting: boolean
  removing: boolean
  isBusy: boolean
  /** The SSH-access API and hosts; absent where managed servers aren't available (web). */
  sshAccessApi?: Pick<ManagedOrcadPreloadApi, 'linkSshAccess' | 'unlinkSshAccess'> | null
  sshTargets?: SshTarget[]
  managed?: ManagedServerLifecycle | null
  onOpenUpdate: () => void
  onDisconnect: (environment: PublicKnownRuntimeEnvironment) => void
  onConnect: (environment: PublicKnownRuntimeEnvironment) => void
  onRemove: (environment: PublicKnownRuntimeEnvironment) => void
  onMakeDefault?: (environment: PublicKnownRuntimeEnvironment) => void
  onCheckForUpdates?: (options: UpdateCheckOptions) => void
  onChanged?: () => void
  /** Re-reads SSH hosts; the route dialog lists them. */
  onRefreshSshTargets?: () => void
  /** Re-probes every server; offered when the host answered but Orca didn't. */
  onRecheck?: () => void
  rechecking?: boolean
}

export function RuntimeServerRow({
  environment,
  duplicateOfNames = NO_DUPLICATES,
  details,
  isActive,
  remoteUpdate,
  remoteServerUpdatesRunning,
  connecting,
  switching,
  disconnecting,
  removing,
  isBusy,
  sshAccessApi = null,
  sshTargets = NO_SSH_TARGETS,
  managed = null,
  onOpenUpdate,
  onDisconnect,
  onConnect,
  onRemove,
  onMakeDefault,
  onCheckForUpdates,
  onChanged,
  onRefreshSshTargets,
  onRecheck,
  rechecking = false
}: RuntimeServerRowProps): React.JSX.Element {
  const [repairOpen, setRepairOpen] = useState(false)
  const [sshDialogOpen, setSshDialogOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const row = useRuntimeServerRowState(environment, details)
  const actionBusy = connecting || switching || disconnecting || removing
  const repairable = row.repairRoute === 'access-link'
  // Why: the revoked host rejects this token on every Connect; Re-pair is the only way back.
  const canConnect = !(row.accessRevoked && repairable)
  const updateActionable = remoteUpdate?.phase === 'available' || remoteUpdate?.phase === 'failed'
  const deployment = getOrcadSshDeployment(environment)
  const sshAccess = environment.sshAccess
  const pendingSshAccess = environment.pendingSshAccessOperation

  // Why: the transport is up but Orca didn't answer; only a fresh probe can tell more.
  const needsRecheck =
    row.connectionState === 'runtime-unavailable' ||
    row.connectionState === 'workspace-window-closed'
  const primary: 'managed' | 'repair' | 'update' | 'connect' | 'retry' | 'recheck' | null =
    managed && managedServerHasPrimaryAction(managed)
      ? 'managed'
      : row.accessRevoked && repairable
        ? 'repair'
        : updateActionable
          ? 'update'
          : // Why: the first probe hasn't answered yet; Connect would race it.
            !row.isReachable && canConnect && row.connectionState !== 'checking'
            ? row.probeFailed
              ? 'retry'
              : 'connect'
            : needsRecheck && onRecheck
              ? 'recheck'
              : null

  const status: ServerRowStatus = getRuntimeServerStatusIndicator({
    connectionState: row.connectionState,
    accessRevoked: row.accessRevoked,
    compatibilityBlocked: row.compatibilityBlocked,
    probeFailed: row.probeFailed,
    connecting,
    disconnecting,
    remoteUpdate,
    managedNotRunning: Boolean(managed?.status && !managed.status.activeVersion)
  })

  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId)?.endpoint ??
    environment.endpoints[0]?.endpoint ??
    null
  const sshRoute = getRuntimeServerRoute(environment, sshTargets)
  const address = formatRuntimeEndpointAddress(endpoint ?? undefined)
  const problemLine = getRuntimeServerProblemLine({
    environment,
    row,
    remoteUpdate,
    managedStatusError: managed?.statusError ?? null,
    managedSummary: managed ? getManagedServerSummary(managed) : null,
    address,
    duplicateOfNames
  })

  const versionText = getRuntimeServerVersionText(
    remoteUpdate,
    managed?.status?.activeAppVersion ??
      managed?.status?.activeVersion ??
      row.descriptorStatus?.appVersion
  )
  const availableText =
    getRuntimeServerAvailableUpdateText(remoteUpdate) ??
    (managed?.status?.availableUpdate
      ? translate('auto.components.settings.RemoteServerUpdateStatus.available', 'Update available')
      : null)
  const infoParts = [sshRoute ?? address, versionText].filter((part): part is string =>
    Boolean(part)
  )

  const meta = (
    <>
      {problemLine ? (
        <span className={cn('truncate', problemLine.destructive && 'text-destructive')}>
          {problemLine.text}
        </span>
      ) : (
        infoParts.map((part, index) => (
          <span key={part} className="flex min-w-0 shrink items-center gap-1">
            {index > 0 ? <span aria-hidden>·</span> : null}
            <span className="truncate">{part}</span>
          </span>
        ))
      )}
      {!problemLine && availableText ? (
        <span className="flex shrink-0 items-center gap-1 text-status-warning">
          <span aria-hidden className="text-muted-foreground">
            ·
          </span>
          {availableText}
        </span>
      ) : null}
      {problemLine ? (
        <>
          <span aria-hidden>·</span>
          <ServerRowDetailsToggle expanded={expanded} onToggle={() => setExpanded((v) => !v)} />
        </>
      ) : null}
    </>
  )

  const primaryAction =
    primary === 'managed' && managed ? (
      <ManagedServerPrimaryAction lifecycle={managed} />
    ) : primary === 'repair' ? (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() => setRepairOpen(true)}
        disabled={actionBusy}
      >
        <Link2 />
        {translate('auto.components.settings.RuntimeEnvironmentsPane.repair', 'Re-pair…')}
      </Button>
    ) : primary === 'update' ? (
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onOpenUpdate}
        disabled={remoteServerUpdatesRunning || isRemoteServerUpdateInFlight(remoteUpdate)}
      >
        {translate('auto.components.settings.RuntimeEnvironmentsPane.updateServer', 'Update')}
      </Button>
    ) : primary === 'recheck' ? (
      <Button type="button" variant="ghost" size="xs" onClick={onRecheck} disabled={rechecking}>
        {rechecking ? <LoadingSpinner className="size-3" /> : null}
        {translate('auto.components.settings.serverList.retry', 'Retry')}
      </Button>
    ) : primary === 'connect' || primary === 'retry' ? (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={() => onConnect(environment)}
        disabled={actionBusy || row.connectionState === 'checking'}
      >
        {connecting ? <LoadingSpinner className="size-3" /> : null}
        {primary === 'retry'
          ? translate('auto.components.settings.serverList.retry', 'Retry')
          : translate('auto.components.settings.RuntimeEnvironmentsPane.connect', 'Connect')}
      </Button>
    ) : null

  const showSshAccess = sshAccessApi !== null && !deployment && !pendingSshAccess
  const footer =
    pendingSshAccess || expanded || (managed && managedServerHasConfirmation(managed)) ? (
      <>
        {pendingSshAccess && sshAccessApi ? (
          <RuntimeSshAccessControl
            api={sshAccessApi}
            environment={environment}
            targets={sshTargets}
            onChanged={() => onChanged?.()}
          />
        ) : null}
        {managed ? <ManagedServerConfirmations lifecycle={managed} /> : null}
        {expanded ? (
          <RuntimeServerRowDetails
            endpoint={endpoint}
            details={row.effectiveDetails}
            remoteUpdate={remoteUpdate}
            problem={row.problem ?? problemLine?.text ?? null}
            sshRoute={sshRoute}
            unreachable={row.probeFailed}
          >
            {managed ? <ManagedServerDetailLines lifecycle={managed} /> : null}
          </RuntimeServerRowDetails>
        ) : null}
      </>
    ) : null

  return (
    <>
      <ServerListRow
        sectionId={environment.id}
        name={
          deployment
            ? (sshTargets.find((target) => target.id === deployment.sshTargetId)?.label ??
              environment.name)
            : row.title
        }
        descriptor={row.hostDescriptorText}
        chips={
          <>
            {isActive ? (
              <ServerRowChip>
                {translate('auto.components.settings.serverList.defaultChip', 'Default')}
              </ServerRowChip>
            ) : null}
            {!deployment && (sshAccess || environment.connectionDependency === 'ssh-tunnel') ? (
              <ServerRowChip>
                {translate('auto.components.settings.serverList.sshTunnelChip', 'SSH tunnel')}
              </ServerRowChip>
            ) : null}
          </>
        }
        meta={meta}
        status={status}
        primaryAction={primaryAction}
        menuItems={
          <RuntimeServerRowMenuItems
            showUpdate={updateActionable && primary !== 'update'}
            showConnect={
              !row.isReachable && canConnect && primary !== 'connect' && primary !== 'retry'
            }
            showDisconnect={row.isReachable}
            showMakeDefault={Boolean(onMakeDefault) && !isActive}
            sshAccessLinked={showSshAccess ? Boolean(sshAccess) : null}
            detailsExpanded={expanded}
            actionBusy={actionBusy}
            isBusy={isBusy}
            connectDisabled={row.connectionState === 'checking'}
            managedItems={managed ? <ManagedServerMenuItems lifecycle={managed} /> : null}
            onUpdate={onOpenUpdate}
            onConnect={() => onConnect(environment)}
            onDisconnect={() => onDisconnect(environment)}
            onMakeDefault={() => onMakeDefault?.(environment)}
            onCheckForUpdates={onCheckForUpdates}
            onSshAccess={() => {
              onRefreshSshTargets?.()
              setSshDialogOpen(true)
            }}
            onToggleDetails={() => setExpanded((v) => !v)}
            onRemove={() => onRemove(environment)}
          />
        }
        footer={footer}
      />
      <RuntimeRepairDialog
        open={repairOpen}
        onOpenChange={setRepairOpen}
        environmentId={environment.id}
        name={environment.name}
      />
      {showSshAccess && sshAccessApi ? (
        <RuntimeSshAccessDialog
          open={sshDialogOpen}
          api={sshAccessApi}
          environment={environment}
          targets={sshTargets}
          onOpenChange={setSshDialogOpen}
          onChanged={() => onChanged?.()}
        />
      ) : null}
    </>
  )
}

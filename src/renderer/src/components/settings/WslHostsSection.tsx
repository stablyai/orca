import { useState } from 'react'
import { FolderInput, Plus, TerminalSquare, Trash2 } from 'lucide-react'
import {
  ORCAD_HOST_NEWER_DEFERRAL_CODE,
  type WslHostConnectIntent,
  type WslHostStatus
} from '../../../../shared/wsl-host-types'
import { toast } from 'sonner'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { LoadingSpinner } from '../LoadingSpinner'
import { AddRemoteHostDialog, type AddRemoteHostMode } from '../sidebar/AddRemoteHostDialog'
import { HostRemoveDialog } from '../sidebar/HostRemoveDialog'
import {
  openWslHostsExperimentalSetting,
  useWslHostsAcceptNewWork,
  useWslHostsEnabled,
  useWslHostServerFilesMissing,
  wslHostsAvailable
} from '../sidebar/use-wsl-hosts-enabled'
import {
  getWslHostRowDetail,
  getWslHostStatusLabel,
  getWslHostServerFilesMissingLabel,
  getWslHostsTurnedOffLabel
} from '../sidebar/wsl-host-row-status'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { DropdownMenuItem } from '../ui/dropdown-menu'
import { managedServerOutcomeLabel } from './managed-server-copy'
import { ServerListRow, ServerRowChip, type ServerRowStatus } from './runtime-server-list-row'
import { WslMoveOrchestratorStatusLine } from '../wsl-move/WslMoveOrchestratorStatusLine'
import { wslMoveOrchestratorLine } from '../wsl-move/wsl-move-orchestrator-copy'
import {
  useWslMoveOrchestratorStatus,
  wslMoveOrchestratorRecordFor
} from '../wsl-move/wsl-move-orchestrator-status'
import { openWslMoveDialogFor } from '../wsl-move/wsl-move-entry'
import { WslMoveUnfinishedNotice } from '../wsl-move/WslMoveUnfinishedNotice'

function getWslHostRowStatus(
  status: WslHostStatus | undefined,
  unavailable: boolean
): ServerRowStatus | null {
  if (unavailable) {
    return null
  }
  const label = getWslHostStatusLabel(status)
  switch (status?.state) {
    case 'ready':
      return {
        label: translate(
          'auto.components.settings.RuntimeEnvironmentsPane.serverConnected',
          'Connected'
        ),
        tone: 'success'
      }
    case 'connecting':
    case 'reconnecting':
      return label ? { label, tone: 'muted', busy: true } : null
    case 'failed':
      return label ? { label, tone: 'destructive' } : null
    case 'unverifiable':
      return label ? { label, tone: 'warning' } : null
    case 'distro-stopped':
    case 'idle':
      return label ? { label, tone: 'muted' } : null
    case 'closed':
    case undefined:
      return null
  }
}

/** Settings → Orca servers: the WSL distros added as hosts (Windows, experimental). */
export function WslHostsSection({
  onChanged
}: {
  onChanged: () => void
}): React.JSX.Element | null {
  // Read WSL hosts directly because the remote-server catalog excludes them.
  const environments = useAppStore((s) => s.runtimeEnvironments)
  const enabled = useWslHostsEnabled()
  const acceptsNewWork = useWslHostsAcceptNewWork()
  const serverFilesMissing = useWslHostServerFilesMissing()
  // Share unavailable reasons across every listing of the host.
  const unavailableLabel = serverFilesMissing
    ? getWslHostServerFilesMissingLabel()
    : enabled
      ? null
      : getWslHostsTurnedOffLabel()
  const statuses = useAppStore((s) => s.wslHostStatuses)
  const moveRecords = useWslMoveOrchestratorStatus((s) => s.records)
  const [dialogMode, setDialogMode] = useState<AddRemoteHostMode | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PublicKnownRuntimeEnvironment | null>(null)
  const hosts = environments.filter(isWslHostRuntimeEnvironment)
  // Retain disabled hosts so projects cannot appear to vanish; rows explain their idle state.
  if (!wslHostsAvailable() || (!enabled && hosts.length === 0)) {
    return null
  }

  const connect = async (environmentId: string, intent?: WslHostConnectIntent): Promise<void> => {
    const api = window.api.runtimeEnvironments?.wslHosts
    if (!api || connectingId) {
      return
    }
    setConnectingId(environmentId)
    try {
      // Update retries a deferred or skipped update behind the terminal check; Force passes it.
      await api.connect({ environmentId, ...(intent ? { intent } : {}) })
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectingId(null)
    }
  }

  return (
    <div className="scroll-mt-8 space-y-2" data-settings-section="wsl-hosts">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            {translate('auto.components.settings.wslHosts.title', 'WSL hosts')}
            <Badge variant="outline">
              {translate('auto.components.settings.wslHosts.experimental', 'Experimental')}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {unavailableLabel ??
              translate(
                'auto.components.settings.wslHosts.description',
                'Orca runs a server inside each distro. A stopped distro starts only when you open one of its projects or connect it here.'
              )}
          </p>
        </div>
        {enabled && !acceptsNewWork ? null : enabled ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={serverFilesMissing}
            onClick={() => setDialogMode('wsl')}
          >
            <Plus />
            {translate('auto.components.settings.wslHosts.add', 'Add WSL distro')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openWslHostsExperimentalSetting}
          >
            {translate('auto.components.settings.wslHosts.turnOn', 'Turn on in Experimental')}
          </Button>
        )}
      </div>
      {hosts.length > 0 ? (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {hosts.map((environment) => {
            const status = statuses[environment.id]
            const ready = status?.state === 'ready'
            const deferred = unavailableLabel ? null : status?.deferredUpdate
            const connectDisabled =
              unavailableLabel !== null || connectingId !== null || status?.state === 'connecting'
            const distro = environment.orcadDeployment.distro
            const moveLine = unavailableLabel
              ? null
              : wslMoveOrchestratorLine(wslMoveOrchestratorRecordFor(moveRecords, distro))
            return (
              <ServerListRow
                key={environment.id}
                sectionId={environment.id}
                name={environment.name}
                icon={<TerminalSquare className="size-4" />}
                chips={
                  <ServerRowChip>
                    {translate('auto.components.settings.wslHosts.chip', 'WSL')}
                  </ServerRowChip>
                }
                meta={
                  <span className="truncate">
                    {deferred
                      ? `${translate(
                          'auto.components.settings.managedServers.row.deferredVersion',
                          'Update to {{version}} deferred.',
                          { version: deferred.candidateVersion }
                        )} ${managedServerOutcomeLabel({ outcome: 'deferred', code: deferred.code })}`
                      : `${unavailableLabel ?? getWslHostRowDetail(status)}${
                          !unavailableLabel && status?.detail ? ` — ${status.detail}` : ''
                        }`}
                  </span>
                }
                status={getWslHostRowStatus(status, unavailableLabel !== null)}
                footer={moveLine ? <WslMoveOrchestratorStatusLine distro={distro} /> : undefined}
                primaryAction={
                  // A newer Orca's host refuses Update; Force stays in the menu.
                  deferred && deferred.code !== ORCAD_HOST_NEWER_DEFERRAL_CODE ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={connectingId !== null}
                      onClick={() => void connect(environment.id, 'update')}
                    >
                      {translate('auto.components.settings.managedServers.row.update', 'Update')}
                    </Button>
                  ) : ready && !unavailableLabel ? null : (
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={connectDisabled}
                      onClick={() => void connect(environment.id)}
                    >
                      {connectingId === environment.id ? (
                        <LoadingSpinner className="size-3" />
                      ) : null}
                      {translate('auto.components.settings.wslHosts.connect', 'Connect')}
                    </Button>
                  )
                }
                menuItems={
                  <>
                    {deferred?.forceable ? (
                      <DropdownMenuItem
                        disabled={connectingId !== null}
                        onSelect={() => void connect(environment.id, 'force')}
                      >
                        {translate('auto.components.settings.wslHosts.forceUpdate', 'Force update')}
                      </DropdownMenuItem>
                    ) : null}
                    {deferred &&
                    deferred.code !== ORCAD_HOST_NEWER_DEFERRAL_CODE &&
                    !(ready && !unavailableLabel) ? (
                      <DropdownMenuItem
                        disabled={connectDisabled}
                        onSelect={() => void connect(environment.id)}
                      >
                        {translate('auto.components.settings.wslHosts.connect', 'Connect')}
                      </DropdownMenuItem>
                    ) : null}
                    {unavailableLabel || !acceptsNewWork ? null : (
                      <DropdownMenuItem
                        onSelect={() => openWslMoveDialogFor(environment.orcadDeployment.distro)}
                      >
                        <FolderInput />
                        {translate('wslMove.entry.hostRow', 'Move projects from this distro…')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={connectingId !== null}
                      onSelect={() => setRemoving(environment)}
                    >
                      <Trash2 />
                      {translate('auto.components.settings.serverList.remove', 'Remove…')}
                    </DropdownMenuItem>
                  </>
                }
              />
            )
          })}
        </div>
      ) : null}
      {enabled && !serverFilesMissing ? <WslMoveUnfinishedNotice /> : null}
      {removing ? (
        <HostRemoveDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setRemoving(null)
              onChanged()
            }
          }}
          hostId={toRuntimeExecutionHostId(removing.id)}
          label={removing.name}
          target={{ kind: 'wsl', environmentId: removing.id }}
        />
      ) : null}
      <AddRemoteHostDialog
        mode={dialogMode}
        onOpenChange={(mode) => {
          setDialogMode(mode)
          if (mode === null) {
            onChanged()
          }
        }}
      />
    </div>
  )
}

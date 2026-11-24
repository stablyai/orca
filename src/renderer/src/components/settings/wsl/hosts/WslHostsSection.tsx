import { useState } from 'react'
import { FolderInput, Plus, TerminalSquare, Trash2 } from 'lucide-react'
import {
  ORCAD_HOST_NEWER_DEFERRAL_CODE,
  ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE,
  type WslHostConnectIntent,
  type WslHostPastUncountedTerminals,
  type WslHostStatus
} from '../../../../../../shared/remote-runtime/wsl-hosts/wsl-host-types'
import { toast } from 'sonner'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { LoadingSpinner } from '../../../ui/LoadingSpinner'
import {
  AddRemoteHostDialog,
  type AddRemoteHostMode
} from '../../../sidebar/host-admission/ssh/AddRemoteHostDialog'
import { HostRemoveDialog } from '../../../sidebar/host-lifecycle/HostRemoveDialog'
import { WslHostRestartAsWslHostDialog } from './WslHostRestartAsWslHostDialog'
import {
  openWslHostsExperimentalSetting,
  useWslHostsAcceptNewWork,
  useWslHostsPaused,
  useWslHostsEnabled,
  useWslHostServerFilesMissing,
  wslHostsAvailable
} from '../../../../runtime/hosts/wsl/use-wsl-hosts-enabled'
import {
  getWslHostRowDetail,
  getWslHostStatusLabel,
  getWslHostServerFilesMissingLabel,
  getWslHostsPausedLabel,
  getWslHostsTurnedOffLabel
} from '../../../sidebar/host-admission/wsl/wsl-host-row-status'
import { wslHostStatusDetailMessage } from '../../../sidebar/host-admission/wsl/wsl-host-failure-text'
import { Badge } from '../../../ui/badge'
import { Button } from '../../../ui/button'
import { DropdownMenuItem } from '../../../ui/dropdown-menu'
import {
  managedServerOutcomeLabel,
  uncountedForceUpdateMessage
} from '../../runtime-environments/managed-servers/managed-server-copy'
import { ConfirmStrip } from '../../runtime-environments/managed-servers/managed-server-row-content'
import { isOrcadUncountedTerminalsDeferral } from '../../../../../../shared/remote-runtime/orcad-lifecycle/orcad-managed-runtime'
import { ServerListRow, ServerRowChip, type ServerRowStatus } from '../../host-rows/ServerListRow'
import { WslMoveOrchestratorStatusLine } from '../../../wsl-move/WslMoveOrchestratorStatusLine'
import { wslMoveOrchestratorLine } from '../../../wsl-move/wsl-move-orchestrator-copy'
import {
  useWslMoveOrchestratorStatus,
  wslMoveOrchestratorRecordFor
} from '../../../wsl-move/wsl-move-orchestrator-status'
import { openWslMoveDialogFor } from '../../../wsl-move/wsl-move-entry'
import { WslMoveUnfinishedNotice } from '../../../wsl-move/WslMoveUnfinishedNotice'
import { readIpcErrorDetail } from '@/runtime/errors/ipc-error'

function getWslHostRowStatus(
  status: WslHostStatus | undefined,
  unavailable: boolean,
  t: Translate = translate
): ServerRowStatus | null {
  if (unavailable) {
    return null
  }
  const label = getWslHostStatusLabel(status, t)
  switch (status?.state) {
    case 'ready':
      return {
        label: t('auto.components.settings.RuntimeEnvironmentsPane.serverConnected', 'Connected'),
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
  const t = useTranslate()
  // Read WSL hosts directly because the remote-server catalog excludes them.
  const environments = useAppStore((s) => s.runtimeEnvironments)
  const enabled = useWslHostsEnabled()
  const acceptsNewWork = useWslHostsAcceptNewWork()
  const paused = useWslHostsPaused()
  const serverFilesMissing = useWslHostServerFilesMissing()
  // Share unavailable reasons across every listing of the host.
  const unavailableLabel = serverFilesMissing
    ? getWslHostServerFilesMissingLabel(t)
    : enabled
      ? null
      : getWslHostsTurnedOffLabel(t)
  const statuses = useAppStore((s) => s.wslHostStatuses)
  const moveRecords = useWslMoveOrchestratorStatus((s) => s.records)
  const [dialogMode, setDialogMode] = useState<AddRemoteHostMode | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PublicKnownRuntimeEnvironment | null>(null)
  // Forcing past an uncounted census may end terminals the server runs itself, so it asks first.
  const [confirmingForceId, setConfirmingForceId] = useState<string | null>(null)
  const [restarting, setRestarting] = useState<PublicKnownRuntimeEnvironment | null>(null)
  const hosts = environments.filter(isWslHostRuntimeEnvironment)
  // Retain disabled hosts so projects cannot appear to vanish; rows explain their idle state.
  if (!wslHostsAvailable() || (!enabled && hosts.length === 0)) {
    return null
  }

  const connect = async (
    environmentId: string,
    intent?: WslHostConnectIntent,
    pastUncountedTerminals?: WslHostPastUncountedTerminals
  ): Promise<void> => {
    const api = window.api.runtimeEnvironments?.wslHosts
    if (!api || connectingId) {
      return
    }
    setConnectingId(environmentId)
    try {
      // Update retries a deferred or skipped update behind the terminal check; Force passes it.
      await api.connect({
        environmentId,
        ...(intent ? { intent } : {}),
        ...(pastUncountedTerminals ? { pastUncountedTerminals } : {})
      })
      onChanged()
    } catch (error) {
      // The main process's message is for the user; Electron's wrapper and the class name aren't.
      toast.error(readIpcErrorDetail(error) ?? String(error))
    } finally {
      setConnectingId(null)
    }
  }

  return (
    <div className="scroll-mt-8 space-y-2" data-settings-section="wsl-hosts">
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0 space-y-0.5">
          <div className="flex items-center gap-2 text-sm font-medium">
            {t('auto.components.settings.wslHosts.title', 'WSL hosts')}
            <Badge variant="outline">
              {t('auto.components.settings.wslHosts.experimental', 'Experimental')}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {unavailableLabel ??
              (paused
                ? getWslHostsPausedLabel(t)
                : t(
                    'auto.components.settings.wslHosts.description',
                    'Orca runs a server inside each distro. Opening a project never starts a stopped distro: click Start, open a new terminal, or connect it here.'
                  ))}
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
            {t('auto.components.settings.wslHosts.add', 'Add WSL distro')}
          </Button>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={openWslHostsExperimentalSetting}
          >
            {t('auto.components.settings.wslHosts.turnOn', 'Open Experimental')}
          </Button>
        )}
      </div>
      {hosts.length > 0 ? (
        <div className="divide-y divide-border rounded-lg border border-border bg-card">
          {hosts.map((environment) => {
            const status = statuses[environment.id]
            const ready = status?.state === 'ready'
            const deferred = unavailableLabel ? null : status?.deferredUpdate
            // Started by an SSH host, not as a WSL host: a restart, not an update, fixes it.
            const notWslHost = deferred?.code === ORCAD_NOT_WSL_HOST_LAUNCH_DEFERRAL_CODE
            const connectDisabled =
              unavailableLabel !== null || connectingId !== null || status?.state === 'connecting'
            const distro = environment.orcadDeployment.distro
            const moveLine = unavailableLabel
              ? null
              : wslMoveOrchestratorLine(wslMoveOrchestratorRecordFor(moveRecords, distro), t)
            return (
              <ServerListRow
                key={environment.id}
                sectionId={environment.id}
                name={environment.name}
                icon={<TerminalSquare className="size-4" />}
                chips={
                  <ServerRowChip>
                    {t('auto.components.settings.wslHosts.chip', 'WSL')}
                  </ServerRowChip>
                }
                meta={
                  <span className="truncate">
                    {notWslHost
                      ? t(
                          'auto.components.settings.wslHosts.notStartedAsWslHost',
                          "This host's server was started by an SSH host, not as a WSL host, so projects can't move here. Restart it as a WSL host to fix this."
                        )
                      : deferred
                        ? `${t(
                            'auto.components.settings.managedServers.row.deferredVersion',
                            'Update to {{version}} deferred.',
                            { version: deferred.candidateVersion }
                          )} ${managedServerOutcomeLabel({ outcome: 'deferred', code: deferred.code }, t)}`
                        : `${unavailableLabel ?? getWslHostRowDetail(status, t)}${
                            !unavailableLabel && status?.detail
                              ? ` — ${wslHostStatusDetailMessage(status)}`
                              : ''
                          }`}
                  </span>
                }
                status={getWslHostRowStatus(status, unavailableLabel !== null, t)}
                footer={
                  confirmingForceId === environment.id &&
                  deferred?.forceable &&
                  deferred.incumbentVersion !== undefined ? (
                    <ConfirmStrip
                      message={uncountedForceUpdateMessage(t)}
                      confirmLabel={t(
                        'auto.components.settings.managedServers.row.updateAnyway',
                        'Update anyway'
                      )}
                      keepLabel={t('auto.components.settings.managedServers.row.notNow', 'Not now')}
                      disabled={connectingId !== null}
                      onConfirm={() => {
                        setConfirmingForceId(null)
                        // Update's admission, pinned to the build this deferral was decided over.
                        void connect(environment.id, 'update', {
                          incumbentVersion: deferred.incumbentVersion ?? null
                        })
                      }}
                      onKeep={() => setConfirmingForceId(null)}
                    />
                  ) : moveLine ? (
                    <WslMoveOrchestratorStatusLine distro={distro} />
                  ) : undefined
                }
                stackPrimaryActionOnNarrow={notWslHost}
                primaryAction={
                  notWslHost ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={connectingId !== null}
                      onClick={() => setRestarting(environment)}
                    >
                      {t(
                        'auto.components.settings.wslHosts.restartAsWslHost.button',
                        'Restart as WSL host'
                      )}
                    </Button>
                  ) : // A newer Orca's host refuses Update; Force stays in the menu.
                  deferred && deferred.code !== ORCAD_HOST_NEWER_DEFERRAL_CODE ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={connectingId !== null}
                      onClick={() => void connect(environment.id, 'update')}
                    >
                      {t('auto.components.settings.managedServers.row.update', 'Update')}
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
                      {t('auto.components.settings.wslHosts.connect', 'Connect')}
                    </Button>
                  )
                }
                menuItems={
                  <>
                    {deferred?.forceable &&
                    (!isOrcadUncountedTerminalsDeferral(deferred.code) ||
                      deferred.incumbentVersion !== undefined) ? (
                      <DropdownMenuItem
                        disabled={connectingId !== null}
                        onSelect={() =>
                          isOrcadUncountedTerminalsDeferral(deferred.code)
                            ? setConfirmingForceId(environment.id)
                            : void connect(environment.id, 'force')
                        }
                      >
                        {t('auto.components.settings.wslHosts.forceUpdate', 'Force update')}
                      </DropdownMenuItem>
                    ) : null}
                    {deferred &&
                    deferred.code !== ORCAD_HOST_NEWER_DEFERRAL_CODE &&
                    !(ready && !unavailableLabel) ? (
                      <DropdownMenuItem
                        disabled={connectDisabled}
                        onSelect={() => void connect(environment.id)}
                      >
                        {t('auto.components.settings.wslHosts.connect', 'Connect')}
                      </DropdownMenuItem>
                    ) : null}
                    {unavailableLabel || !acceptsNewWork ? null : (
                      <DropdownMenuItem
                        onSelect={() => openWslMoveDialogFor(environment.orcadDeployment.distro)}
                      >
                        <FolderInput />
                        {t('wslMove.entry.hostRow', 'Move projects from this distro…')}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={connectingId !== null}
                      onSelect={() => setRemoving(environment)}
                    >
                      <Trash2 />
                      {t('auto.components.settings.serverList.remove', 'Remove…')}
                    </DropdownMenuItem>
                  </>
                }
              />
            )
          })}
        </div>
      ) : null}
      {enabled && !serverFilesMissing ? <WslMoveUnfinishedNotice /> : null}
      <WslHostRestartAsWslHostDialog
        hostName={restarting?.name ?? null}
        onOpenChange={(open) => {
          if (!open) {
            setRestarting(null)
          }
        }}
        onConfirm={() => {
          const environmentId = restarting?.id
          setRestarting(null)
          if (environmentId) {
            void connect(environmentId, 'restart-as-wsl-host')
          }
        }}
      />
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

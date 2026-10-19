import { useState } from 'react'
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
  useWslHostsEnabled,
  useWslHostServerFilesMissing,
  wslHostsAvailable
} from '../sidebar/use-wsl-hosts-enabled'
import {
  getWslHostRowDetail,
  getWslHostServerFilesMissingLabel,
  getWslHostsTurnedOffLabel
} from '../sidebar/wsl-host-row-status'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { managedServerOutcomeLabel } from './managed-server-copy'

/** Settings → Orca servers: the WSL distros added as hosts (Windows, experimental). */
export function WslHostsSection({
  onChanged
}: {
  onChanged: () => void
}): React.JSX.Element | null {
  // Why the store: the remote-server catalog leaves WSL hosts out, so this reads them itself.
  const environments = useAppStore((s) => s.runtimeEnvironments)
  const enabled = useWslHostsEnabled()
  const serverFilesMissing = useWslHostServerFilesMissing()
  // Why one line for both: a host that cannot run says why, wherever it is listed.
  const unavailableLabel = serverFilesMissing
    ? getWslHostServerFilesMissingLabel()
    : enabled
      ? null
      : getWslHostsTurnedOffLabel()
  const statuses = useAppStore((s) => s.wslHostStatuses)
  const [dialogMode, setDialogMode] = useState<AddRemoteHostMode | null>(null)
  const [connectingId, setConnectingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<PublicKnownRuntimeEnvironment | null>(null)
  const hosts = environments.filter(isWslHostRuntimeEnvironment)
  // Why hosts while off: their projects must not seem to vanish; the rows say why they are idle.
  if (!wslHostsAvailable() || (!enabled && hosts.length === 0)) {
    return null
  }

  const connect = async (environmentId: string, force = false): Promise<void> => {
    const api = window.api.runtimeEnvironments?.wslHosts
    if (!api || connectingId) {
      return
    }
    setConnectingId(environmentId)
    try {
      // A connect retries a deferred update; force takes it over the running terminals.
      await api.connect({ environmentId, force })
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setConnectingId(null)
    }
  }

  return (
    <div className="space-y-2" data-settings-section="wsl-hosts">
      <div className="flex items-start justify-between gap-4">
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
        {enabled ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={serverFilesMissing}
            onClick={() => setDialogMode('wsl')}
          >
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
        <div className="divide-y divide-border rounded-md border border-border">
          {hosts.map((environment) => {
            const status = statuses[environment.id]
            const ready = status?.state === 'ready'
            const deferred = unavailableLabel ? null : status?.deferredUpdate
            return (
              <div key={environment.id} className="flex items-center gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{environment.name}</div>
                  <p className="truncate text-xs text-muted-foreground">
                    {unavailableLabel ?? getWslHostRowDetail(status)}
                    {!unavailableLabel && status?.detail ? ` — ${status.detail}` : ''}
                  </p>
                  {deferred ? (
                    <p className="text-xs text-muted-foreground">
                      {translate(
                        'auto.components.settings.managedServers.row.deferredVersion',
                        'Update to {{version}} deferred.',
                        { version: deferred.candidateVersion }
                      )}{' '}
                      {managedServerOutcomeLabel({
                        outcome: 'deferred',
                        code: deferred.code
                      })}
                    </p>
                  ) : null}
                </div>
                {deferred ? (
                  <>
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={connectingId !== null}
                      onClick={() => void connect(environment.id)}
                    >
                      {translate('auto.components.settings.managedServers.row.update', 'Update')}
                    </Button>
                    {deferred.forceable ? (
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={connectingId !== null}
                        onClick={() => void connect(environment.id, true)}
                      >
                        {translate('auto.components.settings.wslHosts.forceUpdate', 'Force update')}
                      </Button>
                    ) : null}
                  </>
                ) : null}
                {ready && !unavailableLabel ? null : (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={
                      unavailableLabel !== null ||
                      connectingId !== null ||
                      status?.state === 'connecting'
                    }
                    onClick={() => void connect(environment.id)}
                  >
                    {connectingId === environment.id ? <LoadingSpinner className="size-3" /> : null}
                    {translate('auto.components.settings.wslHosts.connect', 'Connect')}
                  </Button>
                )}
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={connectingId !== null}
                  onClick={() => setRemoving(environment)}
                >
                  {translate('auto.components.settings.wslHosts.remove', 'Remove')}
                </Button>
              </div>
            )
          })}
        </div>
      ) : null}
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

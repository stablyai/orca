import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import {
  ORCAD_RECOVERY_CHANGED_STATE_CODE,
  type OrcadManagedRuntimeStatus
} from '../../../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  managedServerOutcomeLabel,
  migrationPhaseLabel,
  recoveryLabel,
  terminalCensusLabel
} from './managed-server-copy'

type ManagedServerAction =
  | 'update'
  | 'rollback'
  | 'recover'
  | 'restoreSnapshot'
  | 'stop'
  | 'cancelStop'
  | 'forget'

type ManagedServerRowProps = {
  api: ManagedOrcadPreloadApi
  environment: PublicKnownRuntimeEnvironment
  onChanged: () => void
}

/** Turns a refusal or deferral into the one line the user acts on. */
function outcomeMessage(result: Parameters<typeof managedServerOutcomeLabel>[0]): string | null {
  return result.outcome === 'deferred' ||
    result.outcome === 'refused' ||
    result.outcome === 'failed'
    ? managedServerOutcomeLabel(result)
    : null
}

// Why: a status that never loaded is unknown, not exited; only a loaded status may say "Not running".
function versionLabel(
  status: OrcadManagedRuntimeStatus | null,
  statusError: string | null
): string {
  if (status) {
    return (
      status.activeVersion ??
      translate('auto.components.settings.managedServers.row.notRunning', 'Not running')
    )
  }
  return statusError
    ? translate('auto.components.settings.managedServers.row.statusUnknown', 'Status unknown')
    : translate('auto.components.settings.managedServers.row.checking', 'Checking…')
}

export function ManagedServerRow({
  api,
  environment,
  onChanged
}: ManagedServerRowProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const [status, setStatus] = useState<OrcadManagedRuntimeStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [busy, setBusy] = useState<ManagedServerAction | 'status' | null>(null)
  const [confirmingStop, setConfirmingStop] = useState(false)
  const [confirmingForget, setConfirmingForget] = useState(false)
  const [confirmingRestore, setConfirmingRestore] = useState(false)

  const loadStatus = useCallback(async () => {
    setBusy('status')
    try {
      const next = await api.getStatus({ selector: environment.id })
      if (mountedRef.current) {
        setStatus(next)
        setStatusError(null)
      }
    } catch (error) {
      if (mountedRef.current) {
        setStatusError(error instanceof Error ? error.message : String(error))
      }
    } finally {
      if (mountedRef.current) {
        setBusy(null)
      }
    }
  }, [api, environment.id, mountedRef])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  const run = async (action: ManagedServerAction): Promise<void> => {
    setBusy(action)
    try {
      const selector = { selector: environment.id }
      const result =
        action === 'update'
          ? await api.update(selector)
          : action === 'rollback'
            ? await api.rollback(selector)
            : action === 'recover' || action === 'restoreSnapshot'
              ? await api.recover({
                  ...selector,
                  acceptChangedState: action === 'restoreSnapshot'
                })
              : action === 'stop'
                ? await api.stop(selector)
                : action === 'forget'
                  ? await api.forget(selector)
                  : await api.cancelStop(selector)
      const message = outcomeMessage(result)
      if (message) {
        toast.message(message)
      }
      if (
        mountedRef.current &&
        action === 'recover' &&
        result.outcome === 'refused' &&
        'code' in result &&
        result.code === ORCAD_RECOVERY_CHANGED_STATE_CODE
      ) {
        setConfirmingRestore(true)
      }
      onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      if (mountedRef.current) {
        setBusy(null)
      }
      void loadStatus()
    }
  }

  const recovery = status?.recovery ?? null
  const disabled = busy !== null
  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex min-w-0 items-center gap-2">
        <div className="truncate text-sm font-medium">{environment.name}</div>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {versionLabel(status, statusError)}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="ml-auto size-7"
          disabled={disabled}
          aria-label={translate(
            'auto.components.settings.managedServers.row.refresh',
            'Refresh status'
          )}
          onClick={() => void loadStatus()}
        >
          {busy === 'status' ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <RefreshCw className="size-3" />
          )}
        </Button>
      </div>
      {statusError ? <p className="text-xs text-destructive">{statusError}</p> : null}
      {statusError && confirmingForget ? (
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.managedServers.row.forgetDescription',
            'Unlinks this server here without contacting its host. If the host comes back, the server may still be running there.'
          )}
        </p>
      ) : null}
      {status ? (
        <div className="space-y-0.5 text-xs text-muted-foreground">
          <p>{terminalCensusLabel(status.terminals)}</p>
          {recovery ? <p>{recoveryLabel(recovery)}</p> : null}
          {status.migration ? (
            <p>
              {translate(
                'auto.components.settings.managedServers.row.migration',
                'Migration: {{phase}}',
                {
                  phase: migrationPhaseLabel(status.migration.phase)
                }
              )}
            </p>
          ) : null}
          {status.deferredUpdate ? (
            <p>
              {translate(
                'auto.components.settings.managedServers.row.deferredVersion',
                'Update to {{version}} deferred.',
                { version: status.deferredUpdate.candidateVersion }
              )}{' '}
              {managedServerOutcomeLabel(status.deferredUpdate)}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-1">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={disabled}
          onClick={() => void run('update')}
        >
          {translate('auto.components.settings.managedServers.row.update', 'Update')}
        </Button>
        {status?.rollbackAvailable ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => void run('rollback')}
          >
            {translate('auto.components.settings.managedServers.row.rollback', 'Roll back')}
          </Button>
        ) : null}
        {recovery && confirmingRestore ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                setConfirmingRestore(false)
                void run('restoreSnapshot')
              }}
            >
              {translate(
                'auto.components.settings.managedServers.row.confirmRestore',
                'Restore snapshot and restart'
              )}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setConfirmingRestore(false)}
            >
              {translate('auto.components.settings.managedServers.row.keepState', 'Keep state')}
            </Button>
          </>
        ) : recovery ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => void run('recover')}
          >
            {translate('auto.components.settings.managedServers.row.recover', 'Recover')}
          </Button>
        ) : null}
        {recovery?.operation === 'decommission' ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() => void run('cancelStop')}
          >
            {translate('auto.components.settings.managedServers.row.cancelStop', 'Cancel stop')}
          </Button>
        ) : null}
        {confirmingStop ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                setConfirmingStop(false)
                void run('stop')
              }}
            >
              {translate(
                'auto.components.settings.managedServers.row.confirmStop',
                'Stop and remove server'
              )}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setConfirmingStop(false)}
            >
              {translate('auto.components.settings.managedServers.row.keep', 'Keep running')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => setConfirmingStop(true)}
          >
            {translate('auto.components.settings.managedServers.row.stop', 'Stop…')}
          </Button>
        )}
        {/* Only once the host failed to answer: a reachable host is stopped, not forgotten. */}
        {statusError && confirmingForget ? (
          <>
            <Button
              type="button"
              size="xs"
              variant="destructive"
              disabled={disabled}
              onClick={() => {
                setConfirmingForget(false)
                void run('forget')
              }}
            >
              {translate(
                'auto.components.settings.managedServers.row.confirmForget',
                'Forget on this desktop'
              )}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setConfirmingForget(false)}
            >
              {translate('auto.components.settings.managedServers.row.keepLinked', 'Keep linked')}
            </Button>
          </>
        ) : statusError ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => setConfirmingForget(true)}
          >
            {translate('auto.components.settings.managedServers.row.forget', 'Forget…')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

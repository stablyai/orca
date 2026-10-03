import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import type { OrcadManagedRuntimeStatus } from '../../../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { ManagedOrcadPreloadApi } from '../../../../preload/api/managed-orcad-api'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { migrationPhaseLabel, recoveryLabel, terminalCensusLabel } from './managed-server-copy'

type ManagedServerAction = 'update' | 'rollback' | 'recover' | 'stop' | 'cancelStop'

type ManagedServerRowProps = {
  api: ManagedOrcadPreloadApi
  environment: PublicKnownRuntimeEnvironment
  onChanged: () => void
}

/** Turns a refusal or deferral into the one line the user acts on. */
function outcomeMessage(result: { outcome: string; reason?: string }): string | null {
  return result.outcome === 'deferred' ||
    result.outcome === 'refused' ||
    result.outcome === 'failed'
    ? (result.reason ?? result.outcome)
    : null
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
            : action === 'recover'
              ? await api.recover(selector)
              : action === 'stop'
                ? await api.stop(selector)
                : await api.cancelStop(selector)
      const message = outcomeMessage(result)
      if (message) {
        toast.message(message)
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
          {status?.activeVersion ??
            translate('auto.components.settings.managedServers.row.notRunning', 'Not running')}
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
                'auto.components.settings.managedServers.row.deferred',
                'Update to {{version}} deferred: {{reason}}',
                {
                  version: status.deferredUpdate.candidateVersion,
                  reason: status.deferredUpdate.reason
                }
              )}
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
        {recovery ? (
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
      </div>
    </div>
  )
}

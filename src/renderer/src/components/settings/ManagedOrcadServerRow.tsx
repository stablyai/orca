import { Loader2, RefreshCw, RotateCcw, ServerCog, ShieldCheck, Trash2 } from 'lucide-react'
import type { OrcadManagedRuntimeStatus } from '../../../../shared/orcad-managed-runtime'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import { translate } from '@/i18n/i18n'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import type {
  ManagedOrcadBusyAction,
  ManagedOrcadConfirmation,
  ManagedOrcadStatusEntry
} from './use-managed-orcad-servers'
import { managedOrcadMigrationDescription } from './ManagedOrcadPendingMigrationRow'

type ManagedOrcadServerRowProps = {
  busyAction: ManagedOrcadBusyAction | null
  environment: PublicKnownRuntimeEnvironment
  error?: string
  isActive: boolean
  onConfirm: (confirmation: ManagedOrcadConfirmation) => void
  onRecover: () => void
  onCancelStop: () => void
  onResume: () => void
  onUpdate: () => void
  statusEntry?: ManagedOrcadStatusEntry
}

export function ManagedOrcadServerRow({
  busyAction,
  environment,
  error,
  isActive,
  onConfirm,
  onRecover,
  onCancelStop,
  onResume,
  onUpdate,
  statusEntry
}: ManagedOrcadServerRowProps): React.JSX.Element {
  const status = statusEntry?.state === 'ready' ? statusEntry.status : null
  const actionBusy = busyAction?.id === environment.id
  const busy = busyAction !== null
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <ServerCog className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{environment.name}</span>
          {isActive ? (
            <Badge variant="secondary">
              {translate('auto.components.settings.ManagedOrcadServersSection.active', 'Active')}
            </Badge>
          ) : null}
          {status?.activeVersion ? (
            <Badge variant="outline" className="font-mono">
              {status.activeVersion}
            </Badge>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {status?.previousVersion
            ? translate(
                'auto.components.settings.ManagedOrcadServersSection.previousVersion',
                'Previous: {{value0}}',
                { value0: status.previousVersion }
              )
            : statusEntry?.state === 'error'
              ? translate(
                  'auto.components.settings.ManagedOrcadServersSection.statusUnavailable',
                  'Status unavailable'
                )
              : translate(
                  'auto.components.settings.ManagedOrcadServersSection.noPreviousVersion',
                  'No rollback version recorded'
                )}
        </p>
        {status?.recovery ? (
          <p className="text-xs text-destructive">{recoveryDescription(status.recovery)}</p>
        ) : null}
        {status?.migration ? (
          <p className="text-xs text-destructive">
            {managedOrcadMigrationDescription(status.migration.phase)}
          </p>
        ) : null}
        {statusEntry?.state === 'error' ? (
          <p className="text-xs text-destructive">{statusEntry.message}</p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        {isActive ? (
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'auto.components.settings.ManagedOrcadServersSection.activeStopHelp',
              'Choose another Active Server in Advanced before stopping this server.'
            )}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">
        {status?.recovery?.operation === 'decommission' && status.recovery.phase === 'prepared' ? (
          <Button type="button" variant="ghost" size="xs" onClick={onCancelStop} disabled={busy}>
            {translate('managedOrcad.cancelStop', 'Cancel Stop')}
          </Button>
        ) : null}
        {status?.recovery ? (
          <Button
            type="button"
            size="xs"
            onClick={onRecover}
            disabled={busy || (isActive && status.recovery.operation === 'decommission')}
          >
            {actionBusy && busyAction.action === 'recover' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <ShieldCheck />
            )}
            {status.recovery.operation === 'decommission'
              ? translate('managedOrcad.retryStop', 'Retry Stop')
              : translate('auto.components.settings.ManagedOrcadServersSection.recover', 'Recover')}
          </Button>
        ) : status?.migration ? (
          <Button type="button" size="xs" onClick={onResume} disabled={busy}>
            {actionBusy && busyAction.action === 'resume' ? (
              <Loader2 className="animate-spin" />
            ) : (
              <ShieldCheck />
            )}
            {translate(
              'auto.components.settings.ManagedOrcadServersSection.resumeSetup',
              'Resume setup'
            )}
          </Button>
        ) : (
          <>
            <Button type="button" variant="ghost" size="xs" onClick={onUpdate} disabled={busy}>
              {actionBusy && busyAction.action === 'update' ? (
                <Loader2 className="animate-spin" />
              ) : (
                <RefreshCw />
              )}
              {translate('auto.components.settings.ManagedOrcadServersSection.update', 'Update')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => {
                if (status?.previousVersion) {
                  onConfirm({
                    kind: 'rollback',
                    environmentId: environment.id,
                    environmentName: environment.name,
                    previousVersion: status.previousVersion
                  })
                }
              }}
              disabled={busy || !status?.rollbackAvailable}
            >
              <RotateCcw />
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.rollback',
                'Rollback'
              )}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground hover:text-destructive"
              onClick={() =>
                onConfirm({
                  kind: 'stop',
                  environmentId: environment.id,
                  environmentName: environment.name
                })
              }
              disabled={busy || isActive}
              aria-label={translate(
                'auto.components.settings.ManagedOrcadServersSection.stop',
                'Stop and unlink {{value0}}',
                { value0: environment.name }
              )}
            >
              {actionBusy && busyAction.action === 'stop' ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Trash2 />
              )}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

function recoveryDescription(recovery: NonNullable<OrcadManagedRuntimeStatus['recovery']>): string {
  const phase = recoveryPhaseLabel(recovery)
  switch (recovery.operation) {
    case 'activate':
      return translate(
        'auto.components.settings.ManagedOrcadServersSection.activationRecoveryRequired',
        'Activation of {{value0}} was interrupted at {{value1}}. The host remains fenced until recovery succeeds.',
        { value0: recovery.version, value1: phase }
      )
    case 'rollback':
      return translate(
        'auto.components.settings.ManagedOrcadServersSection.rollbackRecoveryRequired',
        'Rollback to {{value0}} was interrupted at {{value1}}. The host remains fenced until recovery succeeds.',
        { value0: recovery.version, value1: phase }
      )
    case 'decommission':
      return translate(
        'auto.components.settings.ManagedOrcadServersSection.stopRecoveryRequired',
        'Stop of {{value0}} is pending at {{value1}}. Retrying may stop the server; cancellation requires host confirmation.',
        { value0: recovery.version, value1: phase }
      )
  }
}

function recoveryPhaseLabel(recovery: NonNullable<OrcadManagedRuntimeStatus['recovery']>): string {
  if (recovery.phase === 'prepared') {
    return translate(
      'auto.components.settings.ManagedOrcadServersSection.recoveryPhasePrepared',
      'preparation'
    )
  }
  switch (recovery.operation) {
    case 'activate': {
      switch (recovery.phase) {
        case 'incumbent-stopped':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseStopped',
            'incumbent shutdown'
          )
        case 'snapshot-captured':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseCandidate',
            'candidate activation'
          )
        case 'candidate-ready':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseCommit',
            'activation commit'
          )
      }
      throw new Error('Unknown activation recovery phase')
    }
    case 'rollback': {
      switch (recovery.phase) {
        case 'incumbent-stopped':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseStopped',
            'incumbent shutdown'
          )
        case 'rescue-captured':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseRescue',
            'rescue snapshot'
          )
        case 'rollback-state-restored':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseRestore',
            'state restoration'
          )
        case 'target-ready':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseRollbackCommit',
            'rollback commit'
          )
      }
      throw new Error('Unknown rollback recovery phase')
    }
    case 'decommission': {
      switch (recovery.phase) {
        case 'admission-fenced':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseAdmissionFence',
            'terminal admission fence'
          )
        case 'process-exited':
          return translate(
            'auto.components.settings.ManagedOrcadServersSection.recoveryPhaseProcessExit',
            'process exit commit'
          )
      }
      throw new Error('Unknown stop recovery phase')
    }
  }
}

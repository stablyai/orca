import { ArrowUpCircle, RefreshCw, RotateCcw, ServerOff, Trash2, Wrench } from 'lucide-react'
import type { OrcadManagedRuntimeStatus } from '../../../../shared/orcad-managed-runtime'
import { translate } from '@/i18n/i18n'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import { DropdownMenuItem, DropdownMenuSeparator } from '../ui/dropdown-menu'
import {
  managedServerOutcomeLabel,
  migrationPhaseLabel,
  recoveryLabel,
  terminalCensusLabel
} from './managed-server-copy'
import type { ManagedServerLifecycle } from './use-managed-server-lifecycle'

// Why: a status that never loaded is unknown, not exited; only a loaded status may say "Not running".
export function managedServerVersionLabel(
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

/** The one managed-server fact that should replace the row's meta line, if any. */
export function getManagedServerSummary(lifecycle: ManagedServerLifecycle): string | null {
  const { status, recovery } = lifecycle
  if (recovery) {
    return recoveryLabel(recovery)
  }
  if (status?.migration) {
    return translate(
      'auto.components.settings.managedServers.row.migration',
      'Migration: {{phase}}',
      {
        phase: migrationPhaseLabel(status.migration.phase)
      }
    )
  }
  if (status?.deferredUpdate) {
    return translate(
      'auto.components.settings.managedServers.row.deferredVersion',
      'Update to {{version}} deferred.',
      { version: status.deferredUpdate.candidateVersion }
    )
  }
  return null
}

export function ManagedServerDetailLines({
  lifecycle
}: {
  lifecycle: ManagedServerLifecycle
}): React.JSX.Element {
  const { status, statusError, recovery } = lifecycle
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <p>
        {translate(
          'auto.components.settings.managedServers.row.orcaVersion',
          'Orca on this host: {{version}}',
          {
            version: managedServerVersionLabel(status, statusError)
          }
        )}
      </p>
      {statusError ? <p className="text-destructive">{statusError}</p> : null}
      {status ? (
        <>
          <p>{terminalCensusLabel(status.terminals)}</p>
          {recovery ? <p>{recoveryLabel(recovery)}</p> : null}
          {status.migration ? (
            <p>
              {translate(
                'auto.components.settings.managedServers.row.migration',
                'Migration: {{phase}}',
                { phase: migrationPhaseLabel(status.migration.phase) }
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
        </>
      ) : null}
    </div>
  )
}

export function managedServerHasPrimaryAction(lifecycle: ManagedServerLifecycle): boolean {
  const { recovery } = lifecycle
  return (
    recovery !== null && (recovery.operation === 'decommission' || !lifecycle.confirmingRestore)
  )
}

/** Recovery takes the row's primary slot; Cancel stop wins while a stop is half done. */
export function ManagedServerPrimaryAction({
  lifecycle
}: {
  lifecycle: ManagedServerLifecycle
}): React.JSX.Element | null {
  const { recovery, busy, run } = lifecycle
  if (!recovery || !managedServerHasPrimaryAction(lifecycle)) {
    return null
  }
  const cancelStop = recovery.operation === 'decommission'
  return (
    <Button
      type="button"
      size="xs"
      variant="outline"
      disabled={busy !== null}
      onClick={() => void run(cancelStop ? 'cancelStop' : 'recover')}
    >
      {busy === 'recover' || busy === 'cancelStop' ? <LoadingSpinner className="size-3" /> : null}
      {cancelStop
        ? translate('auto.components.settings.managedServers.row.cancelStop', 'Cancel stop')
        : translate('auto.components.settings.managedServers.row.recover', 'Recover')}
    </Button>
  )
}

function ConfirmStrip({
  message,
  confirmLabel,
  keepLabel,
  disabled,
  onConfirm,
  onKeep
}: {
  message: string | null
  confirmLabel: string
  keepLabel: string
  disabled: boolean
  onConfirm: () => void
  onKeep: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      {message ? <p className="min-w-0 flex-1 text-xs text-muted-foreground">{message}</p> : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button type="button" size="xs" variant="ghost" onClick={onKeep}>
          {keepLabel}
        </Button>
        <Button
          type="button"
          size="xs"
          variant="destructive"
          disabled={disabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </div>
  )
}

export function managedServerHasConfirmation(lifecycle: ManagedServerLifecycle): boolean {
  return (
    lifecycle.confirmingStop ||
    (lifecycle.statusError !== null && lifecycle.confirmingForget) ||
    (lifecycle.recovery !== null && lifecycle.confirmingRestore)
  )
}

/** Second-step confirmations; they stay on the row until answered. */
export function ManagedServerConfirmations({
  lifecycle
}: {
  lifecycle: ManagedServerLifecycle
}): React.JSX.Element | null {
  const { recovery, statusError, busy, run } = lifecycle
  const disabled = busy !== null
  if (lifecycle.confirmingStop) {
    return (
      <ConfirmStrip
        message={translate(
          'auto.components.settings.managedServers.row.stopOrcaDescription',
          'Stops Orca on the SSH host and removes it from this list.'
        )}
        confirmLabel={translate(
          'auto.components.settings.managedServers.row.confirmStop',
          'Stop and remove server'
        )}
        keepLabel={translate('auto.components.settings.managedServers.row.keep', 'Keep running')}
        disabled={disabled}
        onConfirm={() => {
          lifecycle.setConfirmingStop(false)
          void run('stop')
        }}
        onKeep={() => lifecycle.setConfirmingStop(false)}
      />
    )
  }
  // Only once the host failed to answer: a reachable host is stopped, not forgotten.
  if (statusError && lifecycle.confirmingForget) {
    return (
      <ConfirmStrip
        message={translate(
          'auto.components.settings.managedServers.row.forgetDescription',
          'Unlinks this server here without contacting its host. If the host comes back, the server may still be running there.'
        )}
        confirmLabel={translate(
          'auto.components.settings.managedServers.row.confirmForget',
          'Forget on this desktop'
        )}
        keepLabel={translate(
          'auto.components.settings.managedServers.row.keepLinked',
          'Keep linked'
        )}
        disabled={disabled}
        onConfirm={() => {
          lifecycle.setConfirmingForget(false)
          void run('forget')
        }}
        onKeep={() => lifecycle.setConfirmingForget(false)}
      />
    )
  }
  if (recovery && lifecycle.confirmingRestore) {
    return (
      <ConfirmStrip
        message={recoveryLabel(recovery)}
        confirmLabel={translate(
          'auto.components.settings.managedServers.row.confirmRestore',
          'Restore snapshot and restart'
        )}
        keepLabel={translate('auto.components.settings.managedServers.row.keepState', 'Keep state')}
        disabled={disabled}
        onConfirm={() => {
          lifecycle.setConfirmingRestore(false)
          void run('restoreSnapshot')
        }}
        onKeep={() => lifecycle.setConfirmingRestore(false)}
      />
    )
  }
  return null
}

export function ManagedServerMenuItems({
  lifecycle
}: {
  lifecycle: ManagedServerLifecycle
}): React.JSX.Element {
  const { status, statusError, recovery, busy, run } = lifecycle
  const disabled = busy !== null
  return (
    <>
      <DropdownMenuItem disabled={disabled} onSelect={() => void lifecycle.loadStatus()}>
        <RefreshCw />
        {translate('auto.components.settings.managedServers.row.refresh', 'Refresh status')}
      </DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} onSelect={() => void run('update')}>
        <ArrowUpCircle />
        {translate(
          'auto.components.settings.managedServers.row.updateOrcaOnHost',
          'Update Orca on this host'
        )}
      </DropdownMenuItem>
      {status?.rollbackAvailable ? (
        <DropdownMenuItem disabled={disabled} onSelect={() => void run('rollback')}>
          <RotateCcw />
          {translate('auto.components.settings.managedServers.row.rollback', 'Roll back')}
        </DropdownMenuItem>
      ) : null}
      {/* Why: while a stop is half done, Cancel stop holds the primary slot and Recover lives here. */}
      {recovery?.operation === 'decommission' ? (
        <DropdownMenuItem disabled={disabled} onSelect={() => void run('recover')}>
          <Wrench />
          {translate('auto.components.settings.managedServers.row.recover', 'Recover')}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        variant="destructive"
        disabled={disabled}
        onSelect={() => {
          lifecycle.setConfirmingForget(false)
          lifecycle.setConfirmingStop(true)
        }}
      >
        <ServerOff />
        {translate('auto.components.settings.managedServers.row.stop', 'Stop…')}
      </DropdownMenuItem>
      {statusError ? (
        <DropdownMenuItem
          variant="destructive"
          disabled={disabled}
          onSelect={() => {
            lifecycle.setConfirmingStop(false)
            lifecycle.setConfirmingForget(true)
          }}
        >
          <Trash2 />
          {translate('auto.components.settings.managedServers.row.forget', 'Forget…')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}

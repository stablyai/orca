import { Loader2 } from 'lucide-react'
import type {
  AgentHealthCheckId,
  AgentHealthProvider,
  AgentHealthSnapshot
} from '../../../../shared/agent-health'
import type { StatusBarUsageMode } from '../../../../shared/status-bar-usage-mode'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { formatTimeAgo } from './tooltip'
import type { AgentReadinessState } from './agent-readiness'
import type { AgentUpdateUiState } from './use-agent-health'

function healthLabel(state: AgentReadinessState): string {
  switch (state) {
    case 'ready':
      return translate('auto.components.status.bar.AgentHealthRows.healthy', 'Healthy')
    case 'checking':
      return translate('auto.components.status.bar.AgentHealthRows.checking', 'Checking')
    case 'action-required':
      return translate(
        'auto.components.status.bar.AgentHealthRows.actionRequired',
        'Action required'
      )
    case 'degraded':
      return translate('auto.components.status.bar.AgentHealthRows.degraded', 'Degraded')
    case 'unavailable':
      return translate('auto.components.status.bar.AgentHealthRows.unavailable', 'Unavailable')
    case 'unknown':
      return translate('auto.components.status.bar.AgentHealthRows.unknown', 'Unknown')
  }
}

function cliStatusLabel(snapshot: AgentHealthSnapshot | null, pending: boolean): string {
  if (!snapshot) {
    return pending
      ? translate('auto.components.status.bar.AgentHealthRows.checking', 'Checking')
      : translate('auto.components.status.bar.AgentHealthRows.notChecked', 'Not checked')
  }
  return snapshot.cliStatus === 'available'
    ? translate('auto.components.status.bar.AgentHealthRows.available', 'Available')
    : translate('auto.components.status.bar.AgentHealthRows.unavailable', 'Unavailable')
}

function checkLabel(id: AgentHealthCheckId): string {
  switch (id) {
    case 'cli':
      return translate('auto.components.status.bar.AgentHealthRows.cli', 'CLI')
    case 'authentication':
      return translate(
        'auto.components.status.bar.AgentHealthRows.authentication',
        'Authentication'
      )
    case 'provider':
      return translate('auto.components.status.bar.AgentHealthRows.provider', 'Provider')
    case 'websocket':
      return translate('auto.components.status.bar.AgentHealthRows.websocket', 'WebSocket')
  }
}

function checkStatusLabel(status: AgentHealthSnapshot['checks'][number]['status']): string {
  switch (status) {
    case 'ok':
      return translate('auto.components.status.bar.AgentHealthRows.passed', 'Passed')
    case 'warning':
      return translate('auto.components.status.bar.AgentHealthRows.warning', 'Warning')
    case 'failed':
      return translate('auto.components.status.bar.AgentHealthRows.failed', 'Failed')
  }
}

function checkDotClass(status: AgentHealthSnapshot['checks'][number]['status']): string {
  if (status === 'ok') {
    return 'bg-status-success'
  }
  return status === 'warning' ? 'bg-status-warning' : 'bg-destructive'
}

function hasAvailableUpdate(snapshot: AgentHealthSnapshot): boolean {
  return snapshot.updateAvailability === 'available' && Boolean(snapshot.latestVersion)
}

function updateCheckUnavailable(snapshot: AgentHealthSnapshot): boolean {
  return snapshot.updateAvailability !== 'current' && !hasAvailableUpdate(snapshot)
}

function updateStatusLabel(
  snapshot: AgentHealthSnapshot,
  updateState: AgentUpdateUiState | undefined,
  pending: boolean
): string {
  if (pending && updateCheckUnavailable(snapshot)) {
    return translate(
      'auto.components.status.bar.AgentHealthRows.checkingForUpdates',
      'Checking for updates…'
    )
  }
  switch (updateState?.status) {
    case 'updating':
      return translate('auto.components.status.bar.AgentHealthRows.updating', 'Updating…')
    case 'updated':
      return translate(
        'auto.components.status.bar.AgentHealthRows.updatedTo',
        'Updated to v{{value0}}',
        { value0: updateState.version ?? snapshot.version ?? '' }
      )
    case 'current':
      return translate('auto.components.status.bar.AgentHealthRows.latestVersion', 'Latest version')
    case 'failed':
      return translate('auto.components.status.bar.AgentHealthRows.updateFailed', 'Update failed')
    case undefined:
      break
  }
  if (hasAvailableUpdate(snapshot)) {
    return translate(
      'auto.components.status.bar.AgentHealthRows.updateAvailable',
      'v{{value0}} available',
      { value0: snapshot.latestVersion }
    )
  }
  return snapshot.updateAvailability === 'current'
    ? translate('auto.components.status.bar.AgentHealthRows.latestVersion', 'Latest version')
    : translate(
        'auto.components.status.bar.AgentHealthRows.updateStatusUnavailable',
        'Update status unavailable'
      )
}

function updateButtonLabel(updateState: AgentUpdateUiState | undefined): string {
  if (updateState?.status === 'updating') {
    return translate('auto.components.status.bar.AgentHealthRows.updating', 'Updating…')
  }
  if (updateState?.status === 'failed') {
    return translate('auto.components.status.bar.AgentHealthRows.retryUpdate', 'Retry')
  }
  return translate('auto.components.status.bar.AgentHealthRows.updateNow', 'Update')
}

function shouldShowUpdateButton(
  snapshot: AgentHealthSnapshot,
  updateState: AgentUpdateUiState | undefined
): boolean {
  if (snapshot.updateSupported !== true) {
    return false
  }
  if (updateState?.status === 'current' || updateState?.status === 'updated') {
    return false
  }
  return hasAvailableUpdate(snapshot)
}

function shouldShowCheckButton(
  snapshot: AgentHealthSnapshot,
  updateState: AgentUpdateUiState | undefined
): boolean {
  return (
    snapshot.cliStatus === 'available' &&
    updateCheckUnavailable(snapshot) &&
    updateState?.status !== 'updating'
  )
}

export function AgentHealthRows({
  snapshot,
  connectionState,
  pending,
  mode,
  updateState,
  onCheck,
  onUpdate
}: {
  snapshot: AgentHealthSnapshot | null
  connectionState: AgentReadinessState
  pending: boolean
  mode: StatusBarUsageMode
  updateState?: AgentUpdateUiState
  onCheck: (provider: AgentHealthProvider) => void
  onUpdate: (provider: AgentHealthProvider) => void
}): React.JSX.Element {
  const checked = snapshot ? formatTimeAgo(snapshot.checkedAt) : null
  return (
    <div className="px-3.5 pb-1.5">
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-secondary/60 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {translate('auto.components.status.bar.AgentHealthRows.status', 'Status')}
          </span>
          <span className="text-[10px] font-medium text-foreground">
            {cliStatusLabel(snapshot, pending)}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {translate('auto.components.status.bar.AgentHealthRows.health', 'Health')}
          </span>
          <span className="text-[10px] font-medium text-foreground">
            {healthLabel(connectionState)}
          </span>
        </div>
        {snapshot?.version ? (
          <div className="col-span-2 flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>v{snapshot.version}</span>
            {checked ? (
              <>
                <span aria-hidden="true">·</span>
                <span>{checked}</span>
              </>
            ) : null}
          </div>
        ) : null}
        {snapshot && snapshot.cliStatus === 'available' ? (
          <div className="col-span-2 mt-0.5 flex items-center justify-between gap-2 border-t border-border/70 pt-1.5">
            <span
              className={`text-[10px] ${updateState?.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {updateStatusLabel(snapshot, updateState, pending)}
            </span>
            {shouldShowCheckButton(snapshot, updateState) ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={pending}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onCheck(snapshot.provider)
                }}
              >
                {pending ? <Loader2 className="size-3 animate-spin" /> : null}
                {pending
                  ? translate('auto.components.status.bar.AgentHealthRows.checking', 'Checking')
                  : translate('auto.components.status.bar.AgentHealthRows.checkNow', 'Check')}
              </Button>
            ) : shouldShowUpdateButton(snapshot, updateState) ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={updateState?.status === 'updating'}
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  onUpdate(snapshot.provider)
                }}
              >
                {updateState?.status === 'updating' ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : null}
                {updateButtonLabel(updateState)}
              </Button>
            ) : null}
          </div>
        ) : null}
        {mode === 'verbose' && snapshot ? (
          <div className="col-span-2 mt-0.5 flex flex-wrap gap-x-3 gap-y-1 border-t border-border/70 pt-1.5">
            {snapshot.checks.map((check) => (
              <span
                key={check.id}
                className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"
              >
                <span className={`size-1.5 rounded-full ${checkDotClass(check.status)}`} />
                {checkLabel(check.id)}: {checkStatusLabel(check.status)}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

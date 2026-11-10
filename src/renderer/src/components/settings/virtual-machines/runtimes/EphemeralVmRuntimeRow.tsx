import { AlertTriangle, Copy, Loader2, Square, Trash2, X } from 'lucide-react'
import type { EphemeralVmRuntimeRecord } from '../../../../../../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultProjectRoot } from '../../../../../../shared/ephemeral-vm-recipes'
import { useTranslate } from '@/i18n/use-translate'
import { ephemeralVmCleanupErrorText } from '@/runtime/ephemeral-vm/ephemeral-vm-error-copy'
import { cn } from '@/lib/utils'
import { Button } from '../../../ui/button'

type EphemeralVmRuntimeRowProps = {
  runtime: EphemeralVmRuntimeRecord
  statusLabel: string
  cleanupFailed: boolean
  cleanupRunning: boolean
  isStopping: boolean
  disabled: boolean
  onCleanup: () => void
  onStopCleanup: () => void
  onCopyCleanupCommand: () => void
  onForget: () => void
}

export function EphemeralVmRuntimeRow({
  runtime,
  statusLabel,
  cleanupFailed,
  cleanupRunning,
  isStopping,
  disabled,
  onCleanup,
  onStopCleanup,
  onCopyCleanupCommand,
  onForget
}: EphemeralVmRuntimeRowProps): React.JSX.Element {
  const t = useTranslate()
  const hasError = cleanupFailed || runtime.status === 'failed'
  const cleanupError = ephemeralVmCleanupErrorText(runtime)
  const isProvisioning = runtime.status === 'provisioning'
  // Write-ahead rows never got a recipe result, so destroy only knows the instance id.
  const isUntracked = !runtime.recipeResult && !isProvisioning
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div
        className={cn(
          'size-2 shrink-0 rounded-full',
          hasError ? 'bg-destructive' : 'bg-muted-foreground/40'
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium">
            {runtime.workspaceName || runtime.recipeId}
          </div>
          <span className="shrink-0 text-[11px] text-muted-foreground">{statusLabel}</span>
          {hasError ? <AlertTriangle className="size-3.5 shrink-0 text-destructive" /> : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {runtime.recipeId} ·{' '}
          {runtime.recipeResult
            ? getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult)
            : runtime.id}
        </p>
        {cleanupError ? (
          <p className="mt-0.5 truncate text-xs text-destructive">{cleanupError}</p>
        ) : null}
        {isUntracked ? (
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t(
              'auto.components.settings.EphemeralVmRuntimesSection.untrackedRuntimeHint',
              'Orca never received this VM’s details. Cleanup runs destroy with only instance ID {{instanceId}}; if it fails, delete the VM in your provider, then remove it from this list.',
              { instanceId: runtime.id }
            )}
          </p>
        ) : null}
      </div>
      <div className={cn('flex shrink-0 items-center gap-1', isProvisioning && 'hidden')}>
        {isUntracked && !cleanupRunning ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onForget}
            disabled={disabled}
          >
            <X className="size-3" />
            {t(
              'auto.components.settings.EphemeralVmRuntimesSection.removeFromList',
              'Remove from list'
            )}
          </Button>
        ) : null}
        {runtime.cleanupStatus === 'failed' ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onCopyCleanupCommand}
            disabled={disabled}
          >
            <Copy className="size-3" />
            {t('auto.components.settings.EphemeralVmRuntimesSection.copyCleanup', 'Copy command')}
          </Button>
        ) : null}
        {cleanupRunning ? (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onStopCleanup}
            disabled={disabled || isStopping}
          >
            {isStopping ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Square className="size-3" />
            )}
            {isStopping
              ? t(
                  'auto.components.settings.EphemeralVmRuntimesSection.stoppingCleanup',
                  'Stopping…'
                )
              : t(
                  'auto.components.settings.EphemeralVmRuntimesSection.stopCleanup',
                  'Stop cleanup'
                )}
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="gap-1.5 text-muted-foreground hover:text-foreground"
            onClick={onCleanup}
            disabled={disabled}
          >
            <Trash2 className="size-3" />
            {cleanupFailed
              ? t('auto.components.settings.EphemeralVmRuntimesSection.retry', 'Retry cleanup')
              : t('auto.components.settings.EphemeralVmRuntimesSection.cleanup', 'Cleanup')}
          </Button>
        )}
      </div>
    </div>
  )
}

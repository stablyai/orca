import { AlertTriangle, Copy, Loader2, Square, Trash2 } from 'lucide-react'
import type { EphemeralVmRuntimeRecord } from '../../../../shared/ephemeral-vm-runtimes'
import { getEphemeralVmRecipeResultProjectRoot } from '../../../../shared/ephemeral-vm-recipes'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'

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
  onCopyCleanupCommand
}: EphemeralVmRuntimeRowProps): React.JSX.Element {
  const hasError = cleanupFailed || runtime.status === 'failed'
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
          {runtime.recipeId} · {getEphemeralVmRecipeResultProjectRoot(runtime.recipeResult)}
        </p>
        {runtime.cleanupLastError ? (
          <p className="mt-0.5 truncate text-xs text-destructive">{runtime.cleanupLastError}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
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
            {translate(
              'auto.components.settings.EphemeralVmRuntimesSection.copyCleanup',
              'Copy command'
            )}
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
              ? translate(
                  'auto.components.settings.EphemeralVmRuntimesSection.stoppingCleanup',
                  'Stopping…'
                )
              : translate(
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
              ? translate(
                  'auto.components.settings.EphemeralVmRuntimesSection.retry',
                  'Retry cleanup'
                )
              : translate('auto.components.settings.EphemeralVmRuntimesSection.cleanup', 'Cleanup')}
          </Button>
        )}
      </div>
    </div>
  )
}

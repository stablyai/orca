import React from 'react'
import { AlertTriangle, Cloud, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { wakeElapsedSeconds } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

// Prompt-shaped rows: the skeleton reads as "a terminal is coming", not as a generic loading page.
const SKELETON_ROWS = [38, 62, 24, 71, 45, 0, 33, 58, 19, 66, 40, 0, 52, 28]

function TerminalSkeleton(): React.JSX.Element {
  return (
    <div className="absolute inset-0 flex flex-col gap-2.5 overflow-hidden px-4 py-3 font-mono" aria-hidden="true">
      {SKELETON_ROWS.map((width, index) =>
        width === 0 ? (
          <span key={index} className="h-2.5" />
        ) : (
          <span key={index} className="flex items-center gap-2">
            <span className="h-2.5 w-2 rounded-sm bg-muted-foreground/25" />
            <span
              className="h-2.5 rounded-sm bg-muted-foreground/15 motion-safe:animate-pulse"
              style={{ width: `${width}%`, animationDelay: `${index * 90}ms` }}
            />
          </span>
        )
      )}
    </div>
  )
}

/**
 * Covers the workspace while its Orca Cloud VM wakes: a terminal-shaped skeleton (never a blank
 * pane) with a live "Waking… Ns" counter. `leaving` fades it out over the live terminal without
 * moving layout; reduced motion swaps instantly.
 */
export function CloudWakingOverlay({
  wake,
  workspaceName,
  leaving = false,
  onRetry,
  onRestart
}: {
  wake: CloudWakeProgressEvent
  workspaceName: string | null
  leaving?: boolean
  onRetry: () => void
  onRestart: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const failed = wake.phase === 'failed'
  const now = useNow(1_000, !failed && !leaving)
  const seconds = wakeElapsedSeconds(wake.startedAt, Math.max(now, wake.at))
  const title =
    wake.source === 'restart'
      ? t('orcaCloudWorkspace.overlay.restarting', 'Restarting…')
      : wake.source === 'unarchive'
        ? t('orcaCloudWorkspace.overlay.unarchiving', 'Restoring from archive…')
        : wake.phase === 'connecting'
          ? t('orcaCloudWorkspace.overlay.connecting', 'Connecting…')
          : t('orcaCloudWorkspace.overlay.waking', 'Waking…')
  return (
    <div
      className={cn(
        'absolute inset-0 z-30 bg-background',
        'motion-safe:transition-opacity motion-safe:duration-200',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      data-cloud-waking-overlay={wake.phase}
    >
      <TerminalSkeleton />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        {failed ? (
          <div
            role="alert"
            className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
              <div className="min-w-0 space-y-1">
                <div className="text-sm font-medium">
                  {t('orcaCloudWorkspace.overlay.failedTitle', 'Couldn’t wake {{name}}', {
                    name: workspaceName ?? t('orcaCloudWorkspace.thisWorkspace', 'this workspace')
                  })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('orcaCloudWorkspace.overlay.failedDetail', 'Your files and chats are safe on its disk.')}
                </p>
                {wake.message ? (
                  <p className="break-words text-xs text-muted-foreground/80">{wake.message}</p>
                ) : null}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={onRestart}>
                <RotateCw />
                {t('orcaCloudWorkspace.restart', 'Restart')}
              </Button>
              <Button size="sm" onClick={onRetry}>
                {t('orcaCloudWorkspace.overlay.tryAgain', 'Try again')}
              </Button>
            </div>
          </div>
        ) : (
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-2.5 rounded-full border border-border bg-card/95 py-1.5 pr-3.5 pl-2.5 text-sm text-card-foreground shadow-xs backdrop-blur"
          >
            <span className="relative flex size-5 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400">
              <Cloud className="size-3" aria-hidden="true" />
            </span>
            <span className="font-medium">{title}</span>
            {/* Seconds tick every second; announce only the phase, not each tick. */}
            <span className="tabular-nums text-muted-foreground" aria-hidden="true">
              {seconds}s
            </span>
          </div>
        )}
      </div>
    </div>
  )
}

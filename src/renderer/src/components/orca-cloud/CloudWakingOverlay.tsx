import React, { useEffect, useRef } from 'react'
import { AlertTriangle, Cloud, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { wakeElapsedSeconds } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

// Prompt lines and output lines of varied length: reads as "a terminal is coming".
const SKELETON: { prompt: boolean; width: number }[] = [
  { prompt: true, width: 28 },
  { prompt: false, width: 64 },
  { prompt: false, width: 52 },
  { prompt: false, width: 71 },
  { prompt: false, width: 18 },
  { prompt: true, width: 41 },
  { prompt: false, width: 58 },
  { prompt: false, width: 35 },
  { prompt: true, width: 22 },
  { prompt: false, width: 67 },
  { prompt: false, width: 46 },
  { prompt: true, width: 12 }
]

function TerminalSkeleton(): React.JSX.Element {
  return (
    <div
      className="absolute inset-0 flex flex-col gap-2 overflow-hidden px-4 py-3 font-mono text-xs text-muted-foreground/40"
      aria-hidden="true"
    >
      {SKELETON.map((line, index) => (
        <span key={index} className="flex h-3 items-center gap-2">
          {line.prompt ? <span className="w-2 leading-none">$</span> : <span className="w-2" />}
          <span
            className="h-2 rounded-sm bg-muted-foreground/15 motion-safe:animate-pulse [animation-duration:2.4s]"
            style={{ width: `${line.width}%`, animationDelay: `${index * 140}ms` }}
          />
        </span>
      ))}
    </div>
  )
}

/**
 * Covers the workspace while its Orca Cloud workspace wakes: a terminal-shaped skeleton (never a
 * blank pane) with a live "Waking… Ns" pill. The same overlay for every wake source (open,
 * message, Wake button, restart, unarchive). `leaving` fades it out over the live terminal
 * without moving layout; reduced motion swaps instantly.
 */
export function CloudWakingOverlay({
  wake,
  workspaceName,
  leaving = false,
  onRetry,
  onRestart,
  onDismiss
}: {
  wake: CloudWakeProgressEvent
  workspaceName: string | null
  leaving?: boolean
  onRetry: () => void
  onRestart: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const failed = wake.phase === 'failed'
  const ticking = !failed && !leaving
  const now = useNow(1_000, ticking)
  const seconds = wakeElapsedSeconds(wake.startedAt, Math.max(now, wake.at))
  const retryRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    // The overlay covers a live pane that may hold focus: move focus to the overlay itself.
    if (failed) {
      retryRef.current?.focus()
    } else {
      rootRef.current?.focus()
    }
  }, [failed])
  const name = workspaceName ?? t('orcaCloudWorkspace.thisWorkspace', 'this workspace')
  const title =
    wake.source === 'restart'
      ? t('orcaCloudWorkspace.overlay.restarting', 'Restarting…')
      : wake.source === 'unarchive'
        ? t('orcaCloudWorkspace.overlay.unarchiving', 'Restoring from archive…')
        : t('orcaCloudWorkspace.overlay.waking', 'Waking…')
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={cn(
        'absolute inset-0 z-30 bg-background outline-none',
        'motion-safe:transition-opacity motion-safe:duration-200',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      data-cloud-waking-overlay={wake.phase}
      data-cloud-overlay="cover"
      aria-label={failed ? undefined : t('orcaCloudWorkspace.overlay.label', '{{name}} is waking', { name })}
    >
      <TerminalSkeleton />
      <div className="absolute inset-0 flex items-center justify-center p-4">
        {failed ? (
          <div
            role="alert"
            className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-medium">
                  {t('orcaCloudWorkspace.overlay.failedTitle', 'Couldn’t wake {{name}}', { name })}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t('orcaCloudWorkspace.overlay.failedDetail', 'Your files and chats are saved.')}
                </p>
              </div>
              <Button
                size="icon-xs"
                variant="ghost"
                className="-mt-1 -mr-1 text-muted-foreground"
                aria-label={t('orcaCloudWorkspace.dismiss', 'Dismiss')}
                onClick={onDismiss}
              >
                <X />
              </Button>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={onRestart}>
                {t('orcaCloudWorkspace.restartWorkspace', 'Restart workspace')}
              </Button>
              <Button ref={retryRef} size="sm" onClick={onRetry}>
                {t('orcaCloudWorkspace.overlay.tryAgain', 'Try again')}
              </Button>
            </div>
            {wake.message ? (
              <p className="break-words text-[11px] text-muted-foreground/80">{wake.message}</p>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2">
            <div
              role="status"
              className="flex items-center gap-2.5 rounded-full border border-border bg-card/95 py-1.5 pr-3.5 pl-2.5 text-sm text-card-foreground shadow-xs backdrop-blur"
            >
              <span className="flex size-5 items-center justify-center rounded-full bg-sky-500/15 text-sky-600 dark:text-sky-400">
                <Cloud className="size-3" aria-hidden="true" />
              </span>
              <span className="font-medium">{title}</span>
              {/* Ticks every second; only the phase is announced, not each tick. */}
              <span className="tabular-nums text-muted-foreground" aria-hidden="true">
                {t('orcaCloudWorkspace.duration.seconds', '{{s}}s', { s: seconds })}
              </span>
            </div>
            {wake.source === 'message' ? (
              <p className="text-xs text-muted-foreground">
                {t('orcaCloudWorkspace.overlay.messageQueued', 'Your message sends as soon as it’s up.')}
              </p>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

import React, { useEffect, useRef } from 'react'
import { AlertTriangle, Cloud, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatElapsedTime } from '@/components/worktree-creation/worktree-creation-clock'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { wakeElapsedSeconds } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { CloudWakeProgressEvent } from '../../../../shared/hosted-sandbox/cloud-workspace-api'

/** After this long the pill says it's slower than usual; after STUCK_S it offers recovery inline. */
export const WAKE_SLOW_S = 20
export const WAKE_STUCK_S = 60

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

function TerminalSkeleton({ still }: { still: boolean }): React.JSX.Element {
  return (
    <div
      className={cn(
        'absolute inset-0 flex flex-col gap-2 overflow-hidden px-4 py-3 font-mono text-xs text-muted-foreground/40',
        still && 'opacity-40'
      )}
      aria-hidden="true"
    >
      {SKELETON.map((line, index) => (
        <span key={index} className="flex h-3 items-center gap-2">
          <span className="w-2 leading-none">{line.prompt ? '$' : ''}</span>
          <Skeleton
            className={cn('h-2 rounded-sm', still ? 'animate-none' : '[animation-duration:2.4s]')}
            style={{ width: `${line.width}%`, animationDelay: `${index * 140}ms` }}
          />
        </span>
      ))}
    </div>
  )
}

/**
 * Covers the workspace while it wakes: a terminal-shaped skeleton (never a blank pane) with a
 * live "Waking… Ns" pill. The same overlay for every wake source (open, message, Wake, restart,
 * unarchive). Slow wakes say so at 20 s and offer recovery at 60 s; a failed wake becomes a
 * dismissible card. `leaving` fades it out over the live terminal without moving layout.
 */
export function CloudWakingOverlay({
  wake,
  workspaceName,
  leaving = false,
  autoFocus = true,
  onRetry,
  onRestart,
  onDismiss
}: {
  wake: CloudWakeProgressEvent
  workspaceName: string | null
  leaving?: boolean
  /** Move focus into the overlay (only when it covers the pane that had focus). */
  autoFocus?: boolean
  onRetry: () => void
  onRestart: () => void
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const failed = wake.phase === 'failed'
  const now = useNow(1_000, !failed && !leaving)
  const seconds = wakeElapsedSeconds(wake.startedAt, Math.max(now, wake.at))
  const slow = !failed && seconds >= WAKE_SLOW_S
  const stuck = !failed && seconds >= WAKE_STUCK_S
  const retryRef = useRef<HTMLButtonElement | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!autoFocus) {
      return
    }
    if (failed) {
      retryRef.current?.focus()
    } else {
      rootRef.current?.focus()
    }
  }, [failed, autoFocus])
  const name = workspaceName || t('orcaCloudWorkspace.thisWorkspaceTitle', 'This workspace')
  const title =
    wake.source === 'restart'
      ? t('orcaCloudWorkspace.overlay.restarting', 'Restarting…')
      : wake.source === 'unarchive'
        ? t('orcaCloudWorkspace.overlay.unarchiving', 'Restoring from archive…')
        : t('orcaCloudWorkspace.overlay.waking', 'Waking…')
  const hint = stuck
    ? t('orcaCloudWorkspace.overlay.stuck', 'This is taking much longer than usual.')
    : slow
      ? t('orcaCloudWorkspace.overlay.slow', 'Taking longer than usual…')
      : wake.source === 'message'
        ? t('orcaCloudWorkspace.overlay.messageQueued', 'Your message sends as soon as it’s up.')
        : null
  // Announced once each (the text changes only when crossing 20 s and 60 s).
  const slowAnnouncement = stuck ? hint : slow ? hint : ''
  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={cn(
        'absolute inset-0 bg-background outline-none',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-150',
        'motion-safe:transition-opacity motion-safe:duration-200',
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      )}
      data-cloud-waking-overlay={wake.phase}
      role="group"
      aria-label={
        failed
          ? undefined
          : wake.source === 'restart'
            ? t('orcaCloudWorkspace.announce.restarting', 'Restarting {{name}}.', { name })
            : wake.source === 'unarchive'
              ? t('orcaCloudWorkspace.announce.unarchiving', 'Restoring {{name}} from archive.', { name })
              : t('orcaCloudWorkspace.announce.waking', 'Waking {{name}}.', { name })
      }
    >
      <TerminalSkeleton still={failed} />
      <div role="status" className="sr-only">
        {failed ? '' : slowAnnouncement}
      </div>
      <div className="absolute inset-0 flex items-center justify-center p-4">
        {failed ? (
          <div
            role="alert"
            className="flex w-full max-w-sm flex-col gap-3 rounded-lg border border-border bg-card p-4 text-card-foreground shadow-xs"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                className="mt-0.5 size-4 shrink-0 text-status-warning"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1">
                <div className="text-sm font-medium">
                  {t('orcaCloudWorkspace.overlay.failedTitle', 'Couldn’t wake {{name}}', { name })}
                </div>
                {wake.message ? (
                  <p className="break-words text-xs text-foreground">{wake.message}</p>
                ) : null}
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
                {t('orcaCloudWorkspace.restartSandbox', 'Restart sandbox')}
              </Button>
              <Button ref={retryRef} size="sm" onClick={onRetry}>
                {t('orcaCloudWorkspace.overlay.tryAgain', 'Try again')}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className={cn(
              'flex flex-col items-center text-card-foreground',
              hint && 'w-full max-w-xs gap-2 rounded-lg border border-border bg-card p-3 shadow-xs'
            )}
          >
            <div
              className={cn(
                'flex items-center gap-2.5 text-sm',
                !hint &&
                  'rounded-full border border-border bg-card/95 py-1.5 pr-3.5 pl-2.5 shadow-xs backdrop-blur'
              )}
            >
              <span className="flex size-5 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Cloud className="size-3" aria-hidden="true" />
              </span>
              <span className="font-medium">{title}</span>
              {/* Ticks every second; only phase changes and the slow/stuck hints are announced. */}
              <span className="tabular-nums text-muted-foreground" aria-hidden="true">
                {formatElapsedTime(seconds * 1000)}
              </span>
            </div>
            {hint ? <p className="text-center text-xs text-muted-foreground">{hint}</p> : null}
            {stuck ? (
              <div className="flex gap-2">
                <Button size="xs" variant="ghost" onClick={onRestart}>
                  {t('orcaCloudWorkspace.restartSandbox', 'Restart sandbox')}
                </Button>
                <Button size="xs" onClick={onRetry}>
                  {t('orcaCloudWorkspace.overlay.tryAgain', 'Try again')}
                </Button>
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

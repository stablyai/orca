import { Loader2, RotateCcw, Square } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatUiRelativeTime } from '@/i18n/relative-time-format'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import { formatStepDuration } from './build-steps'
import { FOCUS_RING } from '../orca-cloud/cloud-focus'
import { BuildStatusIcon, stepStatusFromBuild, useNow } from './BuildStatusIcon'
import {
  buildStatusLabel,
  isBuildInProgress,
  repoDisplayName,
  shortSha,
  stepLabel
} from './cloud-environment-copy'
import type { EnvironmentBuildView } from './cloud-environment-types'

const identityActor = (actor: string): string => actor

export function BuildHistoryList({
  builds,
  selectedBuildId,
  canAdmin,
  busyBuildId,
  now: fixedNow,
  actorName = identityActor,
  onSelect,
  onCancel,
  onActivate
}: {
  builds: readonly EnvironmentBuildView[]
  selectedBuildId: string | null
  canAdmin: boolean
  /** A cancel/activate request is in flight for this build. */
  busyBuildId: string | null
  /** Fixed clock (fixtures); otherwise the list ticks itself while a build runs. */
  now?: number
  actorName?: (actor: string) => string
  onSelect: (build: EnvironmentBuildView) => void
  onCancel: (build: EnvironmentBuildView) => void
  onActivate: (build: EnvironmentBuildView) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  // The 1 s tick lives here, not in the panel, so the form and log don't re-render with it.
  const anyInProgress = builds.some((build) => isBuildInProgress(build.status))
  const tickingNow = useNow(anyInProgress && fixedNow === undefined)
  const now = fixedNow ?? tickingNow
  if (builds.length === 0) {
    return (
      <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
        {t('cloudEnvironment.history.empty', 'No builds yet.')}
      </p>
    )
  }
  const multiRepo = builds.some((build) => build.repos.length > 1)
  return (
    <ul
      className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border"
      aria-label={t('cloudEnvironment.history.aria', 'Build history')}
    >
      {builds.map((build) => {
        const selected = build.id === selectedBuildId
        const inProgress = isBuildInProgress(build.status)
        const busy = busyBuildId === build.id
        const duration =
          build.durationMs ?? (inProgress ? Math.max(0, now - build.createdAt) : null)
        return (
          <li
            key={build.id}
            className={cn(
              'group/build relative flex items-center gap-3 px-3 py-2 transition-colors motion-reduce:transition-none',
              selected ? 'bg-accent/60' : 'hover:bg-accent/30'
            )}
          >
            {selected ? (
              <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-foreground/70" />
            ) : null}
            <button
              type="button"
              aria-current={selected ? 'true' : undefined}
              onClick={() => onSelect(build)}
              className={cn(
                'flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left',
                FOCUS_RING
              )}
            >
              <BuildStatusIcon status={stepStatusFromBuild(build.status)} />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-sm font-medium tabular-nums">#{build.number}</span>
                  <span
                    className={cn(
                      'text-xs',
                      build.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
                    )}
                  >
                    {buildStatusLabel(build.status, t)}
                    {build.status === 'failed' && build.failedStep
                      ? ` · ${stepLabel(build.failedStep, t)}`
                      : ''}
                  </span>
                  {build.active ? (
                    <Badge
                      variant="outline"
                      className="h-4 border-status-success-border bg-status-success-background px-1.5 text-[10px] font-semibold tracking-wide text-status-success uppercase"
                    >
                      {t('cloudEnvironment.history.active', 'Active')}
                    </Badge>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-muted-foreground">
                  <span>{actorName(build.createdBy)}</span>
                  <span aria-hidden>·</span>
                  <time dateTime={new Date(build.createdAt).toISOString()}>
                    {formatUiRelativeTime(build.createdAt - now, intlLocale)}
                  </time>
                  {duration !== null ? (
                    <>
                      <span aria-hidden>·</span>
                      <span className="tabular-nums">{formatStepDuration(duration)}</span>
                    </>
                  ) : null}
                  {build.repos.map((repo) =>
                    repo.commit ? (
                      <span key={repo.url} className="font-mono">
                        <span aria-hidden>· </span>
                        {multiRepo ? `${repoDisplayName(repo.url).split('/')[1]}@` : ''}
                        {shortSha(repo.commit)}
                      </span>
                    ) : null
                  )}
                </div>
              </div>
            </button>
            {canAdmin ? (
              <div className="flex shrink-0 items-center gap-1">
                {inProgress ? (
                  <DisabledReason
                    reason={
                      build.status === 'snapshotting'
                        ? t(
                            'cloudEnvironment.history.cannotCancel',
                            'The snapshot is being saved; the build can no longer be canceled.'
                          )
                        : null
                    }
                  >
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      disabled={busy || build.status === 'snapshotting'}
                      onClick={() => onCancel(build)}
                    >
                      {busy ? (
                        <Loader2 className="animate-spin motion-reduce:animate-none" />
                      ) : (
                        <Square />
                      )}
                      {t('cloudEnvironment.history.cancel', 'Cancel')}
                    </Button>
                  </DisabledReason>
                ) : build.status === 'succeeded' && !build.active ? (
                  <ActivateButton build={build} busy={busy} onActivate={onActivate} />
                ) : null}
              </div>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

function ActivateButton({
  build,
  busy,
  onActivate
}: {
  build: EnvironmentBuildView
  busy: boolean
  onActivate: (build: EnvironmentBuildView) => void
}): React.JSX.Element {
  const t = useTranslate()
  const button = (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      disabled={busy || !build.activatable}
      onClick={() => onActivate(build)}
      className="opacity-80 group-hover/build:opacity-100 focus-visible:opacity-100"
    >
      {busy ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <RotateCcw />}
      {t('cloudEnvironment.history.use', 'Use this build')}
    </Button>
  )
  return (
    <DisabledReason
      reason={
        build.activatable
          ? null
          : t(
              'cloudEnvironment.history.pruned',
              'Snapshot removed: only the newest 5 successful builds keep theirs.'
            )
      }
    >
      {button}
    </DisabledReason>
  )
}

/** A disabled control that says why: the span keeps the tooltip reachable by pointer and keyboard. */
function DisabledReason({
  reason,
  children
}: {
  reason: string | null
  children: React.ReactElement
}): React.JSX.Element {
  if (!reason) {
    return children
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} aria-label={reason} className={cn('rounded-md', FOCUS_RING)}>
          {children}
        </span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  )
}

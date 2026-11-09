import { useCallback, useEffect, useRef, useState } from 'react'
import { ExternalLink, GitPullRequest, History, Loader2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  CloudApiResult,
  RoutineRun,
  RoutineRunPage
} from '../../../../../shared/cloud-api/cloud-api-types'
import { cloudApiErrorCopy, routineRunTriggerLabel } from './cloud-api-copy'
import { formatAbsoluteTime, formatRelativeFromNow, formatRunDuration } from './cloud-api-format'
import { CloudApiErrorNotice, RoutineRunStatusPill } from './cloud-api-parts'
import { isActiveRunStatus } from './routine-run-status'

export type LoadRoutineRuns = (
  routineId: string,
  before?: number | string
) => Promise<CloudApiResult<RoutineRunPage>>

const POLL_MS = 5000

type OkState = Extract<State, { status: 'ok' }>

/**
 * A refresh or poll returns page 1. Older pages the user already loaded stay below it (deduped by
 * id) with their cursor, so polling never collapses "Show older runs".
 */
function mergeFirstPage(current: State, page: RoutineRunPage): State {
  if (current.status !== 'ok' || current.runs.length <= page.runs.length) {
    return {
      status: 'ok',
      runs: page.runs,
      nextBefore: page.nextBefore,
      loadingMore: current.status === 'ok' ? current.loadingMore : false,
      ...(current.status === 'ok' && current.moreError ? { moreError: current.moreError } : {})
    }
  }
  const fresh = new Set(page.runs.map((run) => run.id))
  const merged: OkState = {
    ...current,
    runs: [...page.runs, ...current.runs.filter((run) => !fresh.has(run.id))]
  }
  return merged
}

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ok'
      runs: RoutineRun[]
      nextBefore: number | string | null
      loadingMore: boolean
      moreError?: string
    }

// One grid for every row so status, trigger, start, duration and links line up down the list.
const ROW_GRID =
  'grid grid-cols-[7.5rem_minmax(0,1fr)_6.5rem_4.5rem_5rem] items-center gap-x-3 text-xs'

/**
 * Inline run history for one routine. Loads on mount and on `refreshKey` changes (keeping the
 * current rows on screen), polls while a run is in flight, and reports the newest run so the
 * list row's status pill never disagrees with the history.
 */
export function RoutineRunHistory({
  routineId,
  loadRuns,
  refreshKey = 0,
  onLatestRun,
  onOpenWorkspace,
  fixedNow
}: {
  routineId: string
  loadRuns: LoadRoutineRuns
  refreshKey?: number
  onLatestRun?: (run: RoutineRun | null) => void
  /** Opens a run's cloud workspace; when absent, runs carry no workspace action. */
  onOpenWorkspace?: (workspaceId: string) => void
  /** Fixtures pin the clock so relative and elapsed times are deterministic. */
  fixedNow?: number
}): React.JSX.Element {
  const t = useTranslate()
  const [state, setState] = useState<State>({ status: 'loading' })
  const [liveNow, setNow] = useState(() => Date.now())
  const now = fixedNow ?? liveNow
  const generation = useRef(0)
  const moreGeneration = useRef(0)
  const latestRef = useRef(onLatestRun)
  latestRef.current = onLatestRun

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    // Only a first load blanks the list; refreshes and polls keep the rows in place.
    setState((current) => (current.status === 'ok' ? current : { status: 'loading' }))
    const result = await loadRuns(routineId)
    if (mine !== generation.current) {
      return
    }
    setNow(Date.now())
    if (result.ok) {
      setState((current) => mergeFirstPage(current, result.data))
      latestRef.current?.(result.data.runs[0] ?? null)
    } else {
      setState((current) =>
        current.status === 'ok'
          ? current
          : { status: 'error', message: cloudApiErrorCopy(result.error, t, result) }
      )
    }
  }, [loadRuns, routineId, t])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const active = state.status === 'ok' && state.runs.some((run) => isActiveRunStatus(run.status))
  useEffect(() => {
    if (!active || fixedNow !== undefined) {
      return
    }
    // In-flight runs: refetch every few seconds and tick the elapsed clock every second.
    const poll = setInterval(() => void load(), POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [active, fixedNow, load])

  useEffect(
    () => () => {
      generation.current++
      moreGeneration.current++
    },
    []
  )

  const loadMore = async (): Promise<void> => {
    if (state.status !== 'ok' || state.nextBefore === null || state.loadingMore) {
      return
    }
    const mine = ++moreGeneration.current
    setState({ ...state, loadingMore: true, moreError: undefined })
    const result = await loadRuns(routineId, state.nextBefore)
    if (mine !== moreGeneration.current) {
      return
    }
    setState((current) =>
      current.status !== 'ok'
        ? current
        : result.ok
          ? {
              status: 'ok',
              runs: [...current.runs, ...result.data.runs],
              nextBefore: result.data.nextBefore,
              loadingMore: false
            }
          : {
              ...current,
              loadingMore: false,
              moreError: cloudApiErrorCopy(result.error, t, result)
            }
    )
  }

  return (
    <div
      className="mt-3 rounded-lg border border-border/70 bg-background/40"
      aria-busy={state.status === 'loading'}
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <History className="size-3.5 text-muted-foreground" aria-hidden />
        <p className="text-xs font-medium">
          {t('auto.components.settings.cloudRoutines.runs.title', 'Run history')}
        </p>
      </div>
      {state.status === 'loading' ? (
        <div
          className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground"
          role="status"
        >
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          {t('auto.components.settings.cloudRoutines.runs.loading', 'Loading runs…')}
        </div>
      ) : state.status === 'error' ? (
        <div className="p-3">
          <CloudApiErrorNotice message={state.message} onRetry={() => void load()} />
        </div>
      ) : state.runs.length === 0 ? (
        <p className="px-3 py-4 text-xs text-muted-foreground">
          {t(
            'auto.components.settings.cloudRoutines.runs.empty',
            'No runs yet. Use Run now to try it, or wait for its trigger.'
          )}
        </p>
      ) : (
        <>
          <ol className="divide-y divide-border/50">
            {state.runs.map((run) => (
              <RunRow key={run.id} run={run} now={now} onOpenWorkspace={onOpenWorkspace} />
            ))}
          </ol>
          {state.nextBefore !== null ? (
            <div className="border-t border-border/50 px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                aria-disabled={state.loadingMore}
                aria-busy={state.loadingMore}
                onClick={() => void loadMore()}
              >
                {state.loadingMore ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : null}
                {t('auto.components.settings.cloudRoutines.runs.more', 'Show older runs')}
              </Button>
              {state.moreError ? <InlineError title={state.moreError} className="mt-2" /> : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function RunRow({
  run,
  now,
  onOpenWorkspace
}: {
  run: RoutineRun
  now: number
  onOpenWorkspace?: (workspaceId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const started = run.startedAt ?? run.createdAt
  const live = isActiveRunStatus(run.status)
  // A run still going shows a live elapsed time instead of a frozen dash.
  const duration = live
    ? formatRunDuration(Math.max(0, now - started))
    : formatRunDuration(run.durationMs)
  return (
    <li className="grid gap-1.5 px-3 py-2.5">
      <div className={ROW_GRID}>
        <span>
          <RoutineRunStatusPill status={run.status} />
        </span>
        <span className="min-w-0 truncate" title={run.triggerDetail ?? undefined}>
          {routineRunTriggerLabel(run.trigger, t)}
          {run.triggerDetail ? (
            <span className="text-muted-foreground"> · {run.triggerDetail}</span>
          ) : null}
        </span>
        <time
          className="truncate text-muted-foreground"
          dateTime={new Date(started).toISOString()}
          title={formatAbsoluteTime(started, locale)}
        >
          {formatRelativeFromNow(started, now, locale)}
        </time>
        <span className="text-right text-muted-foreground tabular-nums">{duration}</span>
        {/* Icon-only actions with names in tooltips so three always fit the fixed column. */}
        <span className="grid grid-cols-[1.5rem_1.5rem_1.5rem] items-center justify-end gap-0.5">
          {run.result?.prUrl ? (
            <RunAction
              icon={GitPullRequest}
              label={t('auto.components.settings.cloudRoutines.runs.pr', 'Pull request')}
              onClick={() => void window.api.shell.openUrl(run.result!.prUrl!)}
            />
          ) : (
            <span aria-hidden />
          )}
          {run.result?.commentUrl ? (
            <RunAction
              icon={MessageSquare}
              label={t('auto.components.settings.cloudRoutines.runs.comment', 'Comment')}
              onClick={() => void window.api.shell.openUrl(run.result!.commentUrl!)}
            />
          ) : (
            <span aria-hidden />
          )}
          {run.workspaceId && onOpenWorkspace ? (
            <RunAction
              icon={ExternalLink}
              label={t(
                'auto.components.settings.cloudRoutines.runs.openWorkspace',
                'Open workspace'
              )}
              onClick={() => onOpenWorkspace(run.workspaceId!)}
            />
          ) : (
            <span aria-hidden />
          )}
        </span>
      </div>
      {run.result?.summary ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{run.result.summary}</p>
      ) : null}
      {run.error ? (
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-destructive">
            {t('auto.components.settings.cloudRoutines.runs.why', 'Why:')}
          </span>{' '}
          {run.error}
        </p>
      ) : null}
    </li>
  )
}

function RunAction({
  icon: Icon,
  label,
  onClick
}: {
  icon: typeof ExternalLink
  label: string
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label={label} onClick={onClick}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

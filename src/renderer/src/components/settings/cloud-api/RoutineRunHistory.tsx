import { useCallback, useEffect, useRef, useState } from 'react'
import { GitPullRequest, History, Loader2, MessageSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type {
  CloudApiResult,
  RoutineRun,
  RoutineRunPage
} from '../../../../../shared/cloud-api/cloud-api-types'
import { cloudApiErrorCopy, routineRunTriggerLabel } from './cloud-api-copy'
import { formatAbsoluteTime, formatRelativeFromNow, formatRunDuration } from './cloud-api-format'
import { CloudApiErrorNotice, CopyValueButton, RoutineRunStatusPill } from './cloud-api-parts'

export type LoadRoutineRuns = (
  routineId: string,
  before?: number | string
) => Promise<CloudApiResult<RoutineRunPage>>

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ok'; runs: RoutineRun[]; nextBefore: number | string | null; loadingMore: boolean }

/** Inline run history for one routine; loads on mount and on `refreshKey` changes. */
export function RoutineRunHistory({
  routineId,
  loadRuns,
  now,
  refreshKey = 0
}: {
  routineId: string
  loadRuns: LoadRoutineRuns
  now: number
  refreshKey?: number
}): React.JSX.Element {
  const t = useTranslate()
  const [state, setState] = useState<State>({ status: 'loading' })
  const generation = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const mine = ++generation.current
    setState({ status: 'loading' })
    const result = await loadRuns(routineId)
    if (mine !== generation.current) {
      return
    }
    setState(
      result.ok
        ? {
            status: 'ok',
            runs: result.data.runs,
            nextBefore: result.data.nextBefore,
            loadingMore: false
          }
        : { status: 'error', message: cloudApiErrorCopy(result.error, t, result) }
    )
  }, [loadRuns, routineId, t])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  const loadMore = async (): Promise<void> => {
    if (state.status !== 'ok' || state.nextBefore === null) {
      return
    }
    const mine = generation.current
    setState({ ...state, loadingMore: true })
    const result = await loadRuns(routineId, state.nextBefore)
    if (mine !== generation.current) {
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
          : { ...current, loadingMore: false }
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
              <RunRow key={run.id} run={run} now={now} />
            ))}
          </ol>
          {state.nextBefore !== null ? (
            <div className="border-t border-border/50 px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={state.loadingMore}
                onClick={() => void loadMore()}
              >
                {state.loadingMore ? (
                  <Loader2 className="animate-spin motion-reduce:animate-none" />
                ) : null}
                {t('auto.components.settings.cloudRoutines.runs.more', 'Show older runs')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

function RunRow({ run, now }: { run: RoutineRun; now: number }): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const started = run.startedAt ?? run.createdAt
  return (
    <li className="grid gap-1.5 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <RoutineRunStatusPill status={run.status} />
        <span className="text-foreground">
          {routineRunTriggerLabel(run.trigger, t)}
          {run.triggerDetail ? (
            <span className="text-muted-foreground"> · {run.triggerDetail}</span>
          ) : null}
        </span>
        <span className="text-muted-foreground" title={formatAbsoluteTime(started, locale)}>
          {formatRelativeFromNow(started, now, locale)}
        </span>
        <span className="text-muted-foreground tabular-nums">
          {formatRunDuration(run.durationMs, t)}
        </span>
        <span className="ml-auto flex items-center gap-1">
          {run.result?.prUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void window.api.shell.openUrl(run.result!.prUrl!)}
            >
              <GitPullRequest />
              {t('auto.components.settings.cloudRoutines.runs.pr', 'Pull request')}
            </Button>
          ) : null}
          {run.result?.commentUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={() => void window.api.shell.openUrl(run.result!.commentUrl!)}
            >
              <MessageSquare />
              {t('auto.components.settings.cloudRoutines.runs.comment', 'Comment')}
            </Button>
          ) : null}
          {run.workspaceId ? (
            <code className="font-mono text-[11px] text-muted-foreground">{run.workspaceId}</code>
          ) : null}
          {run.workspaceId ? (
            <CopyValueButton
              value={run.workspaceId}
              variant="ghost"
              label={t(
                'auto.components.settings.cloudRoutines.runs.copyWorkspace',
                'Copy workspace ID {{value0}}',
                {
                  value0: run.workspaceId
                }
              )}
            />
          ) : null}
        </span>
      </div>
      {run.result?.summary ? (
        <p className="line-clamp-2 text-xs text-muted-foreground">{run.result.summary}</p>
      ) : null}
      {run.error ? <p className="text-xs text-destructive">{run.error}</p> : null}
    </li>
  )
}

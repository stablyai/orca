import { useCallback, useEffect, useMemo, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { LocalTaskListResult } from '../../../../../shared/local-tasks/local-task-types'
import { computeLocalTaskReadiness } from '../../../../../shared/local-tasks/local-task-scheduling'
import type { LocalTaskReadiness } from '../../../../../shared/local-tasks/local-task-scheduling'
import { useTranslate } from '@/i18n/use-translate'
import { Badge } from '@/components/ui/badge'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { localTasksListForTarget } from '@/runtime/local-tasks/runtime-local-tasks-client'
import type { TaskPageComposerActionsModel } from '../use-task-page-composer-actions'

export function TaskPageLocalContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const t = useTranslate()
  const hostId = model.accountBackedTaskSourceHostId
  const [result, setResult] = useState<LocalTaskListResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    localTasksListForTarget(ipcOrRuntimeTargetForHostId(hostId) ?? { kind: 'local' })
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [hostId])

  useEffect(load, [load])

  const readinessById = useMemo(
    () =>
      new Map((result?.tasks ? computeLocalTaskReadiness(result.tasks) : []).map((r) => [r.id, r])),
    [result]
  )

  const badgeLabel = (r: LocalTaskReadiness | undefined): string | null => {
    if (!r) {
      return null
    }
    switch (r.state) {
      case 'ready':
        return t('auto.components.TaskPage.localReady', 'ready')
      case 'waiting':
        return t('auto.components.TaskPage.localWaiting', 'waiting on {{value0}}', {
          value0: r.on.join(', ')
        })
      case 'claimed':
        return t('auto.components.TaskPage.localClaimed', 'claimed by {{value0}}', { value0: r.by })
      case 'flagged':
        return t('auto.components.TaskPage.localFlagged', 'flagged: {{value0}}', {
          value0: r.reason
        })
      case 'inactive':
        return null
    }
  }

  return (
    <div className="mt-3 flex min-h-0 min-w-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-muted/50 shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2 text-xs text-muted-foreground">
        <span className="truncate" title={result?.folder}>
          {result?.folder ?? ''}
        </span>
        <button
          type="button"
          className="rounded p-1 hover:bg-accent"
          aria-label={t('auto.components.TaskPage.localRefresh', 'Refresh')}
          onClick={load}
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
      {error ? (
        <div className="p-3 text-sm text-destructive">{error}</div>
      ) : result && result.tasks.length === 0 ? (
        <div className="p-3 text-sm text-muted-foreground">
          {t('auto.components.TaskPage.localEmpty', 'No task files in this folder yet.')}
        </div>
      ) : (
        <ul className="min-h-0 overflow-y-auto scrollbar-sleek">
          {(result?.tasks ?? []).map((task) => {
            const badge = badgeLabel(readinessById.get(task.id))
            return (
              <li
                key={task.id}
                className="flex items-baseline gap-3 border-b border-border/30 px-3 py-2 text-sm last:border-b-0"
              >
                <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground">
                  {task.id}
                </span>
                <span className="min-w-0 flex-1 truncate">{task.title}</span>
                {badge ? <Badge variant="outline">{badge}</Badge> : null}
                <span className="shrink-0 text-xs text-muted-foreground">{task.status}</span>
                <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                  {task.updatedAt?.slice(0, 10) ?? ''}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}

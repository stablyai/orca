import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { LocalTaskListResult } from '../../../../../shared/local-tasks/local-task-types'
import { useTranslate } from '@/i18n/use-translate'

export function TaskPageLocalContent(): React.JSX.Element {
  const t = useTranslate()
  const [result, setResult] = useState<LocalTaskListResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.api.localTasks
      .list()
      .then(setResult)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(load, [load])

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
          {(result?.tasks ?? []).map((task) => (
            <li
              key={task.id}
              className="flex items-baseline gap-3 border-b border-border/30 px-3 py-2 text-sm last:border-b-0"
            >
              <span className="w-40 shrink-0 truncate font-mono text-xs text-muted-foreground">
                {task.id}
              </span>
              <span className="min-w-0 flex-1 truncate">{task.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{task.status}</span>
              <span className="w-24 shrink-0 text-right text-xs text-muted-foreground">
                {task.updatedAt?.slice(0, 10) ?? ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

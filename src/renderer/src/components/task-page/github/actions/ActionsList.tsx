import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useDelayedStatus } from '@/hooks/use-delayed-status'
import { ActionsStatus } from '@/components/right-sidebar/ActionsStatus'
import type { useActionsRuns } from '@/components/right-sidebar/use-actions-runs'
import type { ActionsRun } from '../../../../../../shared/github/actions-types'
import { PaginationBar } from '../../PaginationBar'
import {
  GITHUB_TASK_HEADER_SURFACE_CLASS,
  formatRelativeTime
} from '@/components/task-page-source-context'

const grid = 'grid-cols-[88px_minmax(260px,1fr)_140px_140px_100px]'
/** Show bounded run paging with explicit loading, retry, empty and truncation states. */
export function ActionsList({
  model,
  onOpen
}: {
  model: ReturnType<typeof useActionsRuns>
  onOpen: (run: ActionsRun) => void
}) {
  const loading = useDelayedStatus('actions-list', model.loading ? true : null, 150)
  const data = model.data
  const filtered = Boolean(model.query.branch || model.query.status || model.query.workflowId)
  const totalPages = data
    ? Math.max(
        data.page,
        Math.min(
          20,
          data.totalCount === null
            ? data.page + Number(data.hasNextPage)
            : Math.ceil(data.totalCount / data.perPage)
        )
      )
    : 1
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-sleek">
        <div
          className={cn(
            'sticky top-0 z-40 grid h-8 min-w-[760px] gap-3 border-b border-border/50 px-3 text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground [&>span]:flex [&>span]:items-center',
            GITHUB_TASK_HEADER_SURFACE_CLASS,
            grid
          )}
        >
          <span>{translate('auto.components.TaskPage.eb10c32872', 'ID')}</span>
          <span>{translate('auto.components.TaskPage.5eccb3c841', 'Title / Context')}</span>
          <span>{translate('actions.branch', 'Branch')}</span>
          <span>{translate('actions.status', 'Status')}</span>
          <span>{translate('auto.components.TaskPage.f362667d55', 'Updated')}</span>
        </div>
        {loading && (
          <p role="status" className="p-4 text-xs text-muted-foreground">
            {translate('actions.loading', 'Loading runs…')}
          </p>
        )}
        {model.error && (
          <div role="alert" className="flex items-center gap-3 p-4 text-sm text-destructive">
            {model.error}
            <Button variant="outline" size="sm" disabled={model.loading} onClick={model.refresh}>
              {translate('actions.retry', 'Retry')}
            </Button>
          </div>
        )}
        <div className="divide-y divide-border/40">
          {data?.items.map((run) => (
            <button
              key={run.id}
              type="button"
              onClick={() => onOpen(run)}
              className={cn(
                'grid min-h-12 min-w-[760px] w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                grid
              )}
            >
              <span className="inline-flex items-center gap-1 rounded-md border border-border/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
                <Play className="size-3" />#{run.runNumber}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium" title={run.displayTitle}>
                  {run.displayTitle}
                </span>
                <span className="mt-0.5 block truncate text-[12px] text-muted-foreground">
                  {run.name} · {run.actor ?? '—'} · {run.event ?? '—'}
                </span>
              </span>
              <span
                className="min-w-0 truncate text-xs text-muted-foreground"
                title={run.headBranch ?? undefined}
              >
                {run.headBranch ?? '—'}
              </span>
              <span>
                <ActionsStatus status={run.conclusion ?? run.status} pill />
              </span>
              <span
                className="text-xs text-muted-foreground"
                title={run.updatedAt ? new Date(run.updatedAt).toLocaleString() : undefined}
              >
                {run.updatedAt ? formatRelativeTime(run.updatedAt) : '—'}
              </span>
            </button>
          ))}
        </div>
        {data && !model.loading && !model.error && !data.items.length && (
          <p className="p-4 text-sm text-muted-foreground">
            {filtered
              ? translate('actions.noMatches', 'No workflow runs match these filters.')
              : translate('actions.noRuns', 'This repository has no workflow runs.')}
          </p>
        )}
      </div>
      {data && (
        <PaginationBar
          currentPage={data.page - 1}
          totalPages={totalPages}
          loadingTarget={model.loading ? (model.query.page ?? 1) - 1 : null}
          onPageChange={(page) => model.setQuery({ ...model.query, page: page + 1 })}
        />
      )}
      {data?.limitReached && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {translate(
            'actions.runsLimit',
            'Showing up to 1,000 runs. Open Actions on GitHub for older runs.'
          )}
        </p>
      )}
    </div>
  )
}

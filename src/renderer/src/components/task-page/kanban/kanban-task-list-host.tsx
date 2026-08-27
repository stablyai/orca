import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { translate } from '@/i18n/i18n'
import type { KanbanTaskSummary } from '../../../../../shared/kanban-types'
import type {
  KanbanTaskDetailState,
  KanbanTaskListLoadState
} from '../hooks/use-task-page-kanban-fetch'
import type { TaskProvider } from '../../../../../shared/task-providers'
import { KanbanConnectEmpty } from './kanban-connect-empty'
import { KanbanErrorBanner } from './kanban-error-banner'
import { KanbanTaskDetail } from './kanban-task-detail'
import { KanbanTaskList } from './kanban-task-list'

export type KanbanTaskListHostProps = {
  listLoadState: KanbanTaskListLoadState
  detailState: KanbanTaskDetailState
  displayedKanbanTasks: readonly KanbanTaskSummary[]
  onOpenDetail: (task: KanbanTaskSummary) => void
  onStartWorkspace: (task: KanbanTaskSummary) => void
  onRetry: () => void
  onReconnect: () => void
  onCloseDetail: () => void
  onConnect: () => void
  onHideSource: (provider: TaskProvider, label: string) => void
}

export function KanbanTaskListHost({
  listLoadState,
  detailState,
  displayedKanbanTasks,
  onOpenDetail,
  onStartWorkspace,
  onRetry,
  onReconnect,
  onCloseDetail,
  onConnect,
  onHideSource
}: KanbanTaskListHostProps): React.JSX.Element {
  if (listLoadState.kind === 'disconnected') {
    return <KanbanConnectEmpty onConnect={onConnect} onHide={onHideSource} />
  }

  if (listLoadState.kind === 'auth') {
    return (
      <div className="mt-4 flex flex-col overflow-hidden rounded-md border border-t-0 border-border/50 bg-background shadow-sm">
        <KanbanErrorBanner kind="auth" onReconnect={onReconnect} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md border border-t-0 border-border/50 bg-background shadow-sm">
      {listLoadState.kind === 'stale' ? (
        <KanbanErrorBanner kind="network" message={listLoadState.message} onRetry={onRetry} />
      ) : null}
      {listLoadState.kind === 'network-empty' ? (
        <KanbanErrorBanner kind="network" message={listLoadState.message} onRetry={onRetry} />
      ) : null}
      {detailState.kind !== 'idle' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {detailState.kind === 'loading' ? (
            <div className="flex items-center justify-center py-14">
              <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : detailState.kind === 'not-found' ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate('auto.components.kanban.detail.notFound', 'Kanban task not found.')}
              </p>
              <button
                type="button"
                onClick={onCloseDetail}
                className="mt-3 text-sm text-primary underline-offset-2 hover:underline"
              >
                {translate('auto.components.kanban.detail.backToList', 'Back to list')}
              </button>
            </div>
          ) : detailState.kind === 'error' ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate(
                  'auto.components.kanban.detail.error',
                  "Couldn't load this Kanban task."
                )}
              </p>
              <button
                type="button"
                onClick={onCloseDetail}
                className="mt-3 text-sm text-primary underline-offset-2 hover:underline"
              >
                {translate('auto.components.kanban.detail.backToList', 'Back to list')}
              </button>
            </div>
          ) : (
            <KanbanTaskDetail task={detailState.detail} onClose={onCloseDetail} />
          )}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {listLoadState.kind === 'loading' || listLoadState.kind === 'checking' ? (
            <div className="divide-y divide-border/50">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="px-3 py-3">
                  <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                  <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
                </div>
              ))}
            </div>
          ) : listLoadState.kind === 'empty' ? (
            <div className="px-4 py-12 text-center">
              <p className="text-sm font-medium text-foreground">
                {translate('auto.components.kanban.list.empty', 'No Kanban tasks found')}
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                {translate(
                  'auto.components.kanban.list.emptyHint',
                  'Try a different filter or search.'
                )}
              </p>
            </div>
          ) : (
            <KanbanTaskList
              tasks={displayedKanbanTasks}
              selectedTaskId={null}
              onOpenDetail={onOpenDetail}
              onStartWorkspace={onStartWorkspace}
            />
          )}
        </div>
      )}
    </div>
  )
}

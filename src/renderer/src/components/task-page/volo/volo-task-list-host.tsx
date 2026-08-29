import React from 'react'
import { LoaderCircle } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { VoloIcon } from '@/components/icons/VoloIcon'
import { translate } from '@/i18n/i18n'
import { formatRelativeTime } from '../relative-time'
import { VoloTaskWorkspace } from './volo-task-workspace'
import type { VoloBoard, VoloTask } from '../../../../../shared/volo-types'
import type { TaskProvider } from '../../../../../shared/task-providers'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export type VoloTaskListHostProps = {
  voloStatusReady: boolean
  voloConnected: boolean
  setVoloConnectOpen: (open: boolean) => void
  hideTaskSource: (provider: TaskProvider, label: string) => void
  voloLoading: boolean
  voloError: string | null
  voloTasks: readonly VoloTask[]
  displayedVoloTasks: readonly VoloTask[]
  voloSearchInput: string
  selectedVoloTask: VoloTask | null
  selectedVoloBoard: VoloBoard | null
  openVoloDetailPage: (task: VoloTask) => void
  handleUseVoloItem: (task: VoloTask) => void
  closeTaskDetailPage: () => void
  voloDetailSourceContext: TaskSourceContext | null
  onMoveVoloTask: (task: VoloTask, columnId: string) => Promise<void>
}

function columnTone(type: string | undefined): string {
  if (type === 'done') {
    return 'text-muted-foreground'
  }
  if (type === 'in_progress') {
    return 'text-foreground'
  }
  return 'text-muted-foreground'
}

export function VoloTaskListHost({
  voloStatusReady,
  voloConnected,
  setVoloConnectOpen,
  hideTaskSource,
  voloLoading,
  voloError,
  voloTasks,
  displayedVoloTasks,
  voloSearchInput,
  selectedVoloTask,
  selectedVoloBoard,
  openVoloDetailPage,
  handleUseVoloItem,
  closeTaskDetailPage,
  voloDetailSourceContext,
  onMoveVoloTask
}: VoloTaskListHostProps): React.JSX.Element {
  if (!voloStatusReady) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!voloConnected) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <VoloIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate('auto.components.TaskPage.voloConnectTitle', 'Connect Volo')}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {translate(
            'auto.components.TaskPage.voloConnectBody',
            'Browse boards, create tasks, and start workspaces from Volo without leaving Orca.'
          )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setVoloConnectOpen(true)}>
            {translate('auto.components.TaskPage.voloConnectButton', 'Connect Volo')}
          </Button>
          <Button variant="outline" onClick={() => hideTaskSource('volo', 'Volo')}>
            {translate('auto.components.TaskPage.voloHide', 'Hide Volo')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md rounded-t-none border border-t-0 border-border/50 bg-background shadow-sm">
      <div className="flex h-10 flex-none items-center justify-between gap-3 border-b border-border/50 bg-muted/35 px-3">
        <div className="min-w-0 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {translate('auto.components.TaskPage.voloTasksHeader', 'Volo tasks')}
        </div>
        <div className="shrink-0 text-[11px] text-muted-foreground">
          {displayedVoloTasks.length} {translate('auto.components.TaskPage.b7bae28b6a', 'shown')}
        </div>
      </div>
      <div
        className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek"
        style={{ scrollbarGutter: 'stable' }}
      >
        {voloError ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">
            {voloError}
          </div>
        ) : null}
        {voloLoading && voloTasks.length === 0 ? (
          <div className="divide-y divide-border/50">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="px-3 py-3">
                <div className="h-4 w-4/5 animate-pulse rounded bg-muted/70" />
                <div className="mt-2 h-3 w-3/5 animate-pulse rounded bg-muted/60" />
              </div>
            ))}
          </div>
        ) : null}
        {!voloLoading && displayedVoloTasks.length === 0 && !voloError ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {translate('auto.components.TaskPage.voloEmptyTitle', 'No Volo tasks found')}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {voloSearchInput
                ? translate(
                    'auto.components.TaskPage.voloEmptySearch',
                    'Try a different search query.'
                  )
                : translate(
                    'auto.components.TaskPage.voloEmptyPreset',
                    'No tasks match the selected board and filter.'
                  )}
            </p>
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {displayedVoloTasks.map((task) => {
            const selected = selectedVoloTask?.id === task.id
            return (
              <button
                key={task.id}
                type="button"
                onClick={() => openVoloDetailPage(task)}
                className={`flex w-full items-start justify-between gap-3 px-3 py-3 text-left transition ${
                  selected ? 'bg-accent' : 'hover:bg-accent'
                }`}
              >
                <div className="min-w-0">
                  <div className="truncate text-sm text-foreground">
                    <span className="font-medium text-muted-foreground">{task.taskCode}</span>
                    <span className="mx-2 text-muted-foreground/60">·</span>
                    {task.title}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className={columnTone(task.columnType)}>{task.columnName ?? '—'}</span>
                    {task.assigneeName ? <span>{task.assigneeName}</span> : null}
                    <span>{task.priority}</span>
                    <span>{formatRelativeTime(task.updatedAt)}</span>
                  </div>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  onClick={(event) => {
                    event.stopPropagation()
                    handleUseVoloItem(task)
                  }}
                >
                  {translate('auto.components.TaskPage.voloUse', 'Use')}
                </Button>
              </button>
            )
          })}
        </div>
      </div>
      <VoloTaskWorkspace
        task={selectedVoloTask}
        board={selectedVoloBoard}
        onUse={handleUseVoloItem}
        onClose={closeTaskDetailPage}
        onMove={onMoveVoloTask}
        sourceContext={voloDetailSourceContext}
      />
    </div>
  )
}

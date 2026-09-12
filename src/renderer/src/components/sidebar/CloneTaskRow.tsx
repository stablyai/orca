import React from 'react'
import { AlertTriangle, DownloadCloud, Loader2, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import type { CloneTask } from '@/store/slices/clone-tasks'
import { translate } from '@/i18n/i18n'

function statusLabel(task: CloneTask): string {
  if (task.status === 'error') {
    return (
      task.error ?? translate('auto.components.sidebar.CloneTaskRow.cloneFailed', 'Clone failed')
    )
  }
  if (task.percent !== undefined) {
    const phase = task.phase || translate('auto.components.sidebar.CloneTaskRow.cloning', 'Cloning')
    return `${phase} · ${task.percent}%`
  }
  // Why: git emits no percentage before the first receiving/resolving phase;
  // an explicit "Starting…" label keeps the row from reading as frozen.
  return translate('auto.components.sidebar.CloneTaskRow.starting', 'Starting clone…')
}

/**
 * Sidebar row for a backgrounded repository clone (in-progress or failed).
 * Rendered above the project list since the repo doesn't exist yet. Reads its
 * own task by id; the X cancels a running clone or dismisses a finished one.
 */
export function CloneTaskRow({ taskId }: { taskId: string }): React.JSX.Element | null {
  const task = useAppStore((s) => s.cloneTasksById[taskId])
  if (!task) {
    return null
  }

  const isError = task.status === 'error'
  const showBar = task.status === 'cloning' && task.percent !== undefined

  return (
    <div
      className={cn(
        'group flex w-full flex-col gap-1 rounded-md border px-2 py-1.5',
        isError ? 'border-destructive/40' : 'border-transparent hover:bg-sidebar-accent/60'
      )}
    >
      <div className="flex w-full items-center gap-2">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {isError ? (
            <AlertTriangle className="size-3.5 text-destructive" />
          ) : task.percent === undefined ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : (
            <DownloadCloud className="size-3.5 text-muted-foreground" />
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-sidebar-foreground">
            {task.displayName}
          </span>
          <span
            className={cn(
              'block truncate text-[11px]',
              isError ? 'text-destructive/90' : 'text-muted-foreground'
            )}
          >
            {statusLabel(task)}
          </span>
        </span>
        <button
          type="button"
          title={
            task.status === 'cloning'
              ? translate('auto.components.sidebar.CloneTaskRow.cancel', 'Cancel')
              : translate('auto.components.sidebar.CloneTaskRow.dismiss', 'Dismiss')
          }
          aria-label={
            task.status === 'cloning'
              ? translate('auto.components.sidebar.CloneTaskRow.cancelClone', 'Cancel clone')
              : translate('auto.components.sidebar.CloneTaskRow.dismissClone', 'Dismiss clone')
          }
          onClick={() => {
            const store = useAppStore.getState()
            if (task.status === 'cloning') {
              store.cancelCloneTask(taskId)
            } else {
              store.dismissCloneTask(taskId)
            }
          }}
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-opacity hover:bg-sidebar-accent hover:text-foreground focus-visible:opacity-100',
            task.status === 'cloning'
              ? 'can-hover:opacity-0 group-hover:opacity-100'
              : 'opacity-100'
          )}
        >
          <X className="size-3.5" />
        </button>
      </div>
      {showBar && (
        <div className="h-1 w-full overflow-hidden rounded-full bg-secondary">
          <div
            className="h-full rounded-full bg-foreground transition-[width] duration-300 ease-out"
            style={{ width: `${task.percent}%` }}
          />
        </div>
      )}
    </div>
  )
}

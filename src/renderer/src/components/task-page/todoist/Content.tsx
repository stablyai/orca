import { useEffect, useState } from 'react'
import { ArrowRight, LoaderCircle, RefreshCw, Search } from 'lucide-react'
import type { TaskPageComposerActionsModel } from '../../use-task-page-composer-actions'
import type { TodoistTask } from '../../../../../shared/todoist-types'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TodoistIcon } from '@/components/icons/TodoistIcon'
import { TodoistConnectDialog } from '@/components/todoist-connect-dialog'
import { TodoistTaskDrawer } from './TaskDrawer'
import { getTodoistPriorityLabel, sortTodoistTasks } from './todoist-task-order'
import { TodoistTaskStatusBadge } from './TaskStatusBadge'

const SEARCH_DEBOUNCE_MS = 400
const TASK_LIMIT = 200

export function TaskPageTodoistContent({
  model
}: {
  model: TaskPageComposerActionsModel
}): React.JSX.Element {
  const { hideTaskSource, handleUseTodoistItem } = model
  const status = useAppStore((s) => s.todoistStatus)
  const statusChecked = useAppStore((s) => s.todoistStatusChecked)
  const checkTodoistConnection = useAppStore((s) => s.checkTodoistConnection)
  const [connectOpen, setConnectOpen] = useState(false)

  useEffect(() => {
    if (!statusChecked) {
      void checkTodoistConnection()
    }
  }, [checkTodoistConnection, statusChecked])

  if (!statusChecked) {
    return (
      <div className="mt-4 flex items-center justify-center py-14">
        <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }
  if (!status.connected) {
    return (
      <div className="mt-4 flex flex-col items-center justify-center rounded-md border border-border/50 bg-muted/50 px-6 py-14 text-center shadow-sm">
        <TodoistIcon className="mb-4 size-8 text-muted-foreground/60" />
        <p className="text-base font-medium text-foreground">
          {translate(
            'auto.components.TaskPage.todoist.connectTitle',
            'Connect your Todoist account'
          )}
        </p>
        <p className="mt-2 max-w-sm text-sm text-muted-foreground">
          {status.error ??
            translate(
              'auto.components.TaskPage.todoist.connectDescription',
              'Browse your Todoist tasks and start workspaces from them directly from here.'
            )}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button onClick={() => setConnectOpen(true)}>
            {translate('auto.components.TaskPage.todoist.connect', 'Connect Todoist')}
          </Button>
          <Button variant="outline" onClick={() => hideTaskSource('todoist', 'Todoist')}>
            {translate('auto.components.TaskPage.todoist.hide', 'Hide Todoist')}
          </Button>
        </div>
        <TodoistConnectDialog open={connectOpen} onOpenChange={setConnectOpen} />
      </div>
    )
  }
  return <TodoistTaskList onStartWorkspace={handleUseTodoistItem} />
}

function TodoistTaskList({
  onStartWorkspace
}: {
  onStartWorkspace: (task: TodoistTask) => void
}): React.JSX.Element {
  const [queryInput, setQueryInput] = useState('')
  const [query, setQuery] = useState('')
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [tasks, setTasks] = useState<TodoistTask[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedTask, setSelectedTask] = useState<TodoistTask | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [queryInput])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    window.api.todoist
      .listTasks({ query: query || undefined, limit: TASK_LIMIT })
      .then((result) => {
        if (!cancelled) {
          setTasks(sortTodoistTasks(result))
          // Why: show the refreshed copy, and close the drawer once its task drops out of the list;
          // a task completed here stays open so its Completed badge remains visible.
          setSelectedTask((current) =>
            current && !current.completed
              ? (result.find((task) => task.id === current.id) ?? null)
              : current
          )
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setTasks([])
          setError(err instanceof Error ? err.message : String(err))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [query, refreshNonce])

  // Why: like a Jira transition to Done, the row and drawer flip in place; the
  // next refresh drops the task because the API lists only active tasks.
  const handleCompleted = (taskId: string): void => {
    const markCompleted = (task: TodoistTask): TodoistTask =>
      task.id === taskId ? { ...task, completed: true } : task
    setTasks((current) => current.map(markCompleted))
    setSelectedTask((current) => (current ? markCompleted(current) : current))
  }

  return (
    <div className="flex min-h-0 max-h-full flex-col overflow-hidden rounded-md border border-border/50 bg-background shadow-sm">
      <div className="flex flex-none items-center gap-2 border-b border-border/50 bg-muted/35 px-3 py-2">
        <Search className="size-3.5 shrink-0 text-muted-foreground" />
        <Input
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          placeholder={translate(
            'auto.components.TaskPage.todoist.filterPlaceholder',
            'Todoist filter, e.g. today | overdue, #Work, @label'
          )}
          aria-label={translate(
            'auto.components.TaskPage.todoist.filterPlaceholder',
            'Todoist filter, e.g. today | overdue, #Work, @label'
          )}
          className="h-8 min-w-0 flex-1"
        />

        <span className="shrink-0 text-[11px] text-muted-foreground">
          {tasks.length} {translate('auto.components.TaskPage.todoist.shown', 'shown')}
        </span>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={translate('auto.components.TaskPage.todoist.refresh', 'Refresh')}
          onClick={() => setRefreshNonce((n) => n + 1)}
          disabled={loading}
        >
          <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
        {error ? (
          <div className="border-b border-border px-4 py-4 text-sm text-destructive">{error}</div>
        ) : null}
        {!loading && !error && tasks.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <p className="text-sm font-medium text-foreground">
              {translate('auto.components.TaskPage.todoist.empty', 'No Todoist tasks found')}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {query
                ? translate(
                    'auto.components.TaskPage.todoist.emptyFilter',
                    'Try a different Todoist filter.'
                  )
                : translate(
                    'auto.components.TaskPage.todoist.emptyAll',
                    'You have no active tasks.'
                  )}
            </p>
          </div>
        ) : null}
        <div className="divide-y divide-border/50">
          {tasks.map((task) => (
            <TodoistTaskRow
              key={task.id}
              task={task}
              selected={selectedTask?.id === task.id}
              onOpen={setSelectedTask}
              onStartWorkspace={onStartWorkspace}
            />
          ))}
        </div>
      </div>
      <TodoistTaskDrawer
        task={selectedTask}
        onClose={() => setSelectedTask(null)}
        onStartWorkspace={onStartWorkspace}
        onCompleted={handleCompleted}
      />
    </div>
  )
}

function TodoistTaskRow({
  task,
  selected,
  onOpen,
  onStartWorkspace
}: {
  task: TodoistTask
  selected: boolean
  onOpen: (task: TodoistTask) => void
  onStartWorkspace: (task: TodoistTask) => void
}): React.JSX.Element {
  return (
    // Why: the row holds an action button, so a native button wrapper would nest buttons.
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onOpen(task)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen(task)
        }
      }}
      className={cn(
        'group/row grid min-h-12 cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 text-left transition hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:grid-cols-[minmax(0,1fr)_140px_120px_40px_auto]',
        selected && 'bg-accent'
      )}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="min-w-0 truncate text-[13px] font-medium text-foreground">
            {task.content}
          </h3>
          {task.completed ? <TodoistTaskStatusBadge completed className="shrink-0" /> : null}
        </div>
        {task.labels.length > 0 ? (
          <div className="mt-1 flex min-w-0 items-center gap-1">
            {task.labels.slice(0, 3).map((label) => (
              <span
                key={label}
                className="max-w-[140px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className="block truncate text-[12px] text-muted-foreground max-md:!hidden">
        {task.projectName ?? ''}
      </span>
      <span className="block truncate text-[12px] text-muted-foreground max-md:!hidden">
        {task.due?.string ?? task.due?.date ?? ''}
      </span>
      <span className="block text-[12px] text-muted-foreground max-md:!hidden">
        {getTodoistPriorityLabel(task.priority)}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={(event) => {
          event.stopPropagation()
          onStartWorkspace(task)
        }}
      >
        <ArrowRight className="size-3.5" />
        {translate('auto.components.TaskPage.todoist.start', 'Start')}
      </Button>
    </div>
  )
}

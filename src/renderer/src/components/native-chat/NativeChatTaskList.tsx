import { Check, Square } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { NativeChatTask, NativeChatTaskStatus } from '../../../../shared/native-chat-task-list'

// Why: Claude caps the terminal checklist at five rows; matching that density
// keeps task progress useful without displacing the conversation.
const MAX_VISIBLE_TASKS = 5

const TASK_STATUS_ORDER: Record<NativeChatTaskStatus, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2
}

function taskTitle(task: NativeChatTask): string {
  return task.status === 'in_progress' && task.activeForm ? task.activeForm : task.subject
}

export function NativeChatTaskList({
  tasks
}: {
  tasks: readonly NativeChatTask[]
}): React.JSX.Element | null {
  if (tasks.length === 0) {
    return null
  }

  const counts = { pending: 0, in_progress: 0, completed: 0 }
  for (const task of tasks) {
    counts[task.status] += 1
  }
  const sorted = [...tasks].sort(
    (left, right) => TASK_STATUS_ORDER[left.status] - TASK_STATUS_ORDER[right.status]
  )
  const visible = sorted.slice(0, MAX_VISIBLE_TASKS)
  const hidden = sorted.slice(MAX_VISIBLE_TASKS)
  const summary = translate(
    tasks.length === 1
      ? 'components.native-chat.tasks.summaryOne'
      : 'components.native-chat.tasks.summary',
    tasks.length === 1
      ? '1 task ({{value1}} done, {{value2}} in progress, {{value3}} open)'
      : '{{value0}} tasks ({{value1}} done, {{value2}} in progress, {{value3}} open)',
    {
      value0: tasks.length,
      value1: counts.completed,
      value2: counts.in_progress,
      value3: counts.pending
    }
  )
  const hiddenCompleted = hidden.every((task) => task.status === 'completed')

  return (
    <section
      aria-label={summary}
      className="rounded-lg border border-border bg-card px-3 py-2.5 text-xs shadow-xs"
    >
      <div className="mb-1.5 font-mono text-muted-foreground">{summary}</div>
      <ul className="space-y-1 font-mono">
        {visible.map((task) => {
          const completed = task.status === 'completed'
          const inProgress = task.status === 'in_progress'
          return (
            <li
              key={task.id}
              data-status={task.status}
              aria-current={inProgress ? 'step' : undefined}
              className={cn(
                'flex min-w-0 items-start gap-2',
                completed ? 'text-muted-foreground' : 'text-foreground'
              )}
            >
              {completed ? (
                <Check className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              ) : (
                <Square
                  className={cn('mt-0.5 size-3 shrink-0', inProgress && 'fill-current')}
                  aria-hidden="true"
                />
              )}
              <span
                className={cn(
                  'min-w-0 break-words',
                  inProgress && 'font-semibold',
                  completed && 'line-through decoration-border'
                )}
              >
                {taskTitle(task)}
              </span>
            </li>
          )
        })}
      </ul>
      {hidden.length > 0 ? (
        <div className="mt-1.5 font-mono text-muted-foreground">
          {hiddenCompleted
            ? translate('components.native-chat.tasks.moreCompleted', '+{{value0}} completed', {
                value0: hidden.length
              })
            : translate('components.native-chat.tasks.more', '+{{value0}} more', {
                value0: hidden.length
              })}
        </div>
      ) : null}
    </section>
  )
}

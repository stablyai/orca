import { Circle, CircleCheck, CircleDot, ChevronRight, ListChecks } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  diffNativeChatTaskLists,
  nativeChatTaskLabel,
  type NativeChatTask,
  type NativeChatTaskChange,
  type NativeChatTaskList as TaskList
} from '../../../../shared/native-chat-task-list'

function statusLabel(task: NativeChatTask): string {
  if (task.status === 'completed') {
    return translate('components.native-chat.taskList.completed', 'Completed')
  }
  if (task.status === 'in_progress') {
    return translate('components.native-chat.taskList.inProgress', 'In progress')
  }
  return translate('components.native-chat.taskList.pending', 'Pending')
}

function changeLabel(change: NativeChatTaskChange): string {
  const values = { task: change.task.content }
  switch (change.kind) {
    case 'added':
      return translate('components.native-chat.taskList.added', 'Added {{task}}', values)
    case 'removed':
      return translate('components.native-chat.taskList.removed', 'Removed {{task}}', values)
    case 'started':
      return translate('components.native-chat.taskList.started', 'Started {{task}}', values)
    case 'completed':
      return translate('components.native-chat.taskList.finished', 'Completed {{task}}', values)
    case 'pending':
      return translate('components.native-chat.taskList.reset', 'Marked pending: {{task}}', values)
    case 'updated':
      return translate('components.native-chat.taskList.updated', 'Updated {{task}}', {
        task: nativeChatTaskLabel(change.task)
      })
  }
}

function TaskRow({ task, label }: { task: NativeChatTask; label?: string }): React.JSX.Element {
  const Icon =
    task.status === 'completed' ? CircleCheck : task.status === 'in_progress' ? CircleDot : Circle
  return (
    <li
      className={cn(
        'flex items-start gap-1.5 text-xs text-muted-foreground',
        task.status === 'in_progress' && 'font-medium text-foreground'
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="sr-only">{statusLabel(task)}: </span>
      <span
        className={cn(
          'min-w-0 whitespace-pre-wrap break-words',
          !label && task.status === 'completed' && 'line-through'
        )}
      >
        {label ?? nativeChatTaskLabel(task)}
      </span>
    </li>
  )
}

function Checklist({ list }: { list: TaskList }): React.JSX.Element {
  return list.tasks.length === 0 ? (
    <p className="text-xs text-muted-foreground">
      {translate('components.native-chat.taskList.empty', 'No tasks')}
    </p>
  ) : (
    <ul
      aria-label={translate('components.native-chat.taskList.title', 'Tasks')}
      className="space-y-1 py-1"
    >
      {list.tasks.map((task, index) => (
        <TaskRow key={`${task.content}:${index}`} task={task} />
      ))}
    </ul>
  )
}

export function NativeChatTaskList({
  list,
  previous,
  presentation = 'inline'
}: {
  list: TaskList
  previous?: TaskList
  presentation?: 'inline' | 'composer'
}): React.JSX.Element {
  const completed = list.tasks.filter((task) => task.status === 'completed').length
  if (presentation === 'composer') {
    return (
      <Collapsible className="rounded-md border border-border bg-muted/30">
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ListChecks aria-hidden className="size-4 shrink-0" />
          <span className="flex-1 font-medium">
            {translate('components.native-chat.taskList.title', 'Tasks')}
          </span>
          <span
            className="tabular-nums"
            aria-label={translate(
              'components.native-chat.taskList.progress',
              '{{completed}} of {{total}} tasks completed',
              { completed, total: list.tasks.length }
            )}
          >
            {completed}/{list.tasks.length}
          </span>
          <ChevronRight aria-hidden className="size-3.5 group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="max-h-40 overflow-y-auto px-3 pb-2 scrollbar-sleek">
            <Checklist list={list} />
            {list.explanation ? (
              <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {list.explanation}
              </p>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }
  const changes = previous ? diffNativeChatTaskLists(previous, list) : null
  return (
    <div className="space-y-1 py-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ListChecks aria-hidden className="size-4 shrink-0" />
        <span className="font-medium">
          {translate('components.native-chat.taskList.title', 'Tasks')}
        </span>
        <span
          className="tabular-nums"
          aria-label={translate(
            'components.native-chat.taskList.progress',
            '{{completed}} of {{total}} tasks completed',
            { completed, total: list.tasks.length }
          )}
        >
          {completed}/{list.tasks.length}
        </span>
      </div>
      {changes ? (
        <>
          {changes.length > 0 ? (
            <ul className="space-y-1 py-1">
              {changes.map((change, index) => (
                <TaskRow
                  key={`${change.kind}:${index}`}
                  task={change.task}
                  label={changeLabel(change)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {translate('components.native-chat.taskList.unchanged', 'Tasks unchanged')}
            </p>
          )}
          <Collapsible>
            <CollapsibleTrigger className="group flex items-center gap-1 rounded py-0.5 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRight aria-hidden className="size-3.5 group-data-[state=open]:rotate-90" />
              {translate('components.native-chat.taskList.showAll', 'Full task list')}
            </CollapsibleTrigger>
            <CollapsibleContent>
              <Checklist list={list} />
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <Checklist list={list} />
      )}
      {list.explanation ? (
        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {list.explanation}
        </p>
      ) : null}
    </div>
  )
}

import { Circle, CircleCheck, CircleDot, ChevronRight, ListChecks } from 'lucide-react'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import {
  diffNativeChatTaskLists,
  nativeChatCompletedTaskCount,
  nativeChatTaskChangeWords,
  nativeChatTaskLabel,
  type NativeChatTask,
  type NativeChatTaskChange,
  type NativeChatTaskList as TaskList
} from '../../../../../../shared/native-chat/input/native-chat-task-list'

function statusLabel(task: NativeChatTask, t: Translate = translate): string {
  if (task.status === 'completed') {
    return t('components.native-chat.taskList.completed', 'Completed')
  }
  if (task.status === 'in_progress') {
    return t('components.native-chat.taskList.inProgress', 'In progress')
  }
  return t('components.native-chat.taskList.pending', 'Pending')
}

function changeLabel(change: NativeChatTaskChange, t: Translate = translate): string {
  const { key, task } = nativeChatTaskChangeWords(change)
  switch (key) {
    case 'added':
      return t('components.native-chat.taskList.added', 'Added {{task}}', { task })
    case 'removed':
      return t('components.native-chat.taskList.removed', 'Removed {{task}}', { task })
    case 'started':
      return t('components.native-chat.taskList.started', 'Started {{task}}', { task })
    case 'finished':
      return t('components.native-chat.taskList.finished', 'Completed {{task}}', { task })
    case 'reset':
      return t('components.native-chat.taskList.reset', 'Marked pending: {{task}}', {
        task
      })
    case 'updated':
      return t('components.native-chat.taskList.updated', 'Updated {{task}}', { task })
  }
}

function TaskRow({ task, label }: { task: NativeChatTask; label?: string }): React.JSX.Element {
  const t = useTranslate()
  const Icon =
    task.status === 'completed' ? CircleCheck : task.status === 'in_progress' ? CircleDot : Circle
  return (
    <li
      className={cn(
        'flex items-start gap-1.5',
        task.status === 'in_progress' && 'font-medium text-chat-foreground-strong'
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="sr-only">{statusLabel(task, t)}: </span>
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
  const t = useTranslate()
  return list.tasks.length === 0 ? (
    <p className="text-xs">{t('components.native-chat.taskList.empty', 'No tasks')}</p>
  ) : (
    <ul aria-label={t('components.native-chat.taskList.title', 'Tasks')} className="space-y-1 py-1">
      {list.tasks.map((task, index) => (
        <TaskRow key={`${task.content}:${index}`} task={task} />
      ))}
    </ul>
  )
}

function taskProgressLabel(completed: number, total: number, t: Translate = translate): string {
  return t(
    'components.native-chat.taskList.progress',
    '{{completed}} of {{count}} tasks completed',
    { completed, count: total, defaultValue_one: '{{completed}} of {{count}} task completed' }
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
  const t = useTranslate()
  const completed = nativeChatCompletedTaskCount(list)
  if (presentation === 'composer') {
    return (
      <Collapsible className="rounded-md border border-border bg-muted/30">
        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <ListChecks aria-hidden className="size-4 shrink-0" />
          <span className="flex-1 font-medium">
            {t('components.native-chat.taskList.title', 'Tasks')}
          </span>
          <span
            className="tabular-nums"
            aria-label={taskProgressLabel(completed, list.tasks.length, t)}
          >
            {completed}/{list.tasks.length}
          </span>
          <ChevronRight aria-hidden className="size-3.5 group-data-[state=open]:rotate-90" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="max-h-40 overflow-y-auto px-3 pb-2 text-xs text-muted-foreground scrollbar-sleek">
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
    <div className="space-y-1 py-1 text-sm text-chat-foreground-faint">
      <div className="flex items-center gap-1.5 text-xs text-chat-foreground-faint">
        <ListChecks aria-hidden className="size-4 shrink-0" />
        <span className="font-medium">{t('components.native-chat.taskList.title', 'Tasks')}</span>
        <span
          className="tabular-nums"
          aria-label={taskProgressLabel(completed, list.tasks.length, t)}
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
                  label={changeLabel(change, t)}
                />
              ))}
            </ul>
          ) : (
            <p className="text-xs text-chat-foreground-faint">
              {t('components.native-chat.taskList.unchanged', 'Tasks unchanged')}
            </p>
          )}
          <Collapsible>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="group flex items-center gap-1 rounded py-0.5 text-xs text-chat-foreground-faint hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight aria-hidden className="size-3.5 group-data-[state=open]:rotate-90" />
                {t('components.native-chat.taskList.showAll', 'Full task list')}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent animation="height" data-native-chat-member-detail>
              <Checklist list={list} />
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <Checklist list={list} />
      )}
      {list.explanation ? (
        <p className="whitespace-pre-wrap break-words text-xs text-chat-foreground-faint">
          {list.explanation}
        </p>
      ) : null}
    </div>
  )
}

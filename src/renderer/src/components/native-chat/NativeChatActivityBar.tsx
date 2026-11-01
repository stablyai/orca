import { useMemo, useRef, useState } from 'react'
import { Ban, ChevronLeft, ListChecks, Users } from 'lucide-react'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import {
  nativeChatListedSubagents,
  nativeChatSubagentActivities,
  nativeChatVisibleTaskList,
  type NativeChatSubagentActivity
} from '../../../../shared/native-chat/input/native-chat-activity'
import { nativeChatCompletedTaskCount } from '../../../../shared/native-chat/input/native-chat-task-list'
import type { NativeChatTaskSeedList } from '../../../../shared/native-chat/input/native-chat-claude-task-updates'
import type { NativeChatSubagentRow } from '../../../../shared/native-chat/transcript/native-chat-transcript-projection'
import type {
  NativeChatMessage,
  NativeChatSubagentState
} from '../../../../shared/native-chat/native-chat-types'
import { NativeChatTaskList } from './NativeChatTaskList'

function stateLabel(state: NativeChatSubagentState): string {
  switch (state) {
    case 'working':
      return translate('components.native-chat.activity.state.working', 'Working')
    case 'completed':
      return translate('components.native-chat.activity.state.completed', 'Completed')
    case 'idle':
      return translate('components.native-chat.activity.state.idle', 'Idle')
    case 'failed':
      return translate('components.native-chat.activity.state.failed', 'Failed')
    case 'stopped':
      return translate('components.native-chat.activity.state.stopped', 'Stopped')
    case 'unverifiable':
      return translate('components.native-chat.activity.state.unavailable', 'Status unavailable')
  }
}

function pillClass(open: boolean): string {
  return cn(
    'inline-flex h-6.5 items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    open && 'bg-accent text-accent-foreground'
  )
}

// Radix shifts popovers on the main axis only, so a pill-anchored sheet runs past a short composer.
const sheetClass = 'w-80 max-w-(--radix-popper-anchor-width) p-0'

export function NativeChatActivityBar({
  messages,
  subagentRows,
  focusedSubagentId,
  focusedTranscriptLoading = false,
  onFocusSubagent,
  taskList: sessionTaskList = null,
  subagentSeed = null
}: {
  messages: readonly NativeChatMessage[]
  subagentRows: ReadonlyMap<string, readonly NativeChatSubagentRow[]>
  focusedSubagentId: string | null
  focusedTranscriptLoading?: boolean
  onFocusSubagent: (agentId: string | null) => void
  taskList?: NativeChatTaskSeedList | null
  subagentSeed?: readonly NativeChatSubagentActivity[] | null
}): React.JSX.Element | null {
  const list = useMemo(() => {
    const focusedMessages = focusedSubagentId
      ? (subagentRows.get(focusedSubagentId)?.map((row) => row.message) ?? [])
      : null
    return nativeChatVisibleTaskList(messages, focusedMessages, sessionTaskList)
  }, [focusedSubagentId, messages, sessionTaskList, subagentRows])
  const subagents = useMemo(
    () => nativeChatSubagentActivities(messages, subagentRows, subagentSeed),
    [messages, subagentRows, subagentSeed]
  )
  const listed = nativeChatListedSubagents(subagents)
  const [tasksOpen, setTasksOpen] = useState(false)
  const [subagentsOpen, setSubagentsOpen] = useState(false)
  const columnRef = useRef<{ getBoundingClientRect(): DOMRect } | null>(null)
  const focused = subagents.find((agent) => agent.id === focusedSubagentId) ?? null
  const showTasks = list != null && list.tasks.length > 0
  if (!showTasks && listed.length === 0 && !focused) {
    return null
  }
  const completed = list ? nativeChatCompletedTaskCount(list) : 0
  const total = list?.tasks.length ?? 0
  const working = listed.some((agent) => agent.state === 'working')
  return (
    <div className="shrink-0 px-3 pb-2 sm:px-4">
      <div
        ref={(node) => {
          columnRef.current = node
        }}
        className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-1.5"
      >
        {focused ? (
          <div className="flex flex-col gap-0.5">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {translate('components.native-chat.activity.viewing', 'Viewing {{name}}', {
                  name: focused.label
                })}
              </span>
              <button
                type="button"
                className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onFocusSubagent(null)}
              >
                <ChevronLeft aria-hidden className="size-3.5 shrink-0" />
                {translate('components.native-chat.activity.mainAgent', 'Main agent')}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              {translate(
                'components.native-chat.activity.composerStays',
                'The composer still sends to the main agent.'
              )}
            </p>
          </div>
        ) : null}
        {focused &&
        !focusedTranscriptLoading &&
        (subagentRows.get(focused.id)?.length ?? 0) === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'components.native-chat.activity.noMessages',
              'No messages from this subagent yet'
            )}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-1.5">
          {showTasks && list ? (
            <Popover open={tasksOpen} onOpenChange={setTasksOpen}>
              <PopoverAnchor virtualRef={columnRef} />
              <PopoverTrigger className={pillClass(tasksOpen)}>
                <ListChecks aria-hidden className="size-3.5 shrink-0" />
                <span>
                  {translate(
                    'components.native-chat.activity.tasks',
                    '{{completed}}/{{count}} tasks',
                    {
                      completed,
                      count: total,
                      defaultValue_one: '{{completed}}/{{count}} task'
                    }
                  )}
                </span>
                <span
                  aria-hidden
                  className="relative h-1 w-8 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="absolute inset-y-0 left-0 bg-foreground"
                    style={{ width: `${total === 0 ? 0 : (completed / total) * 100}%` }}
                  />
                </span>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                collisionPadding={8}
                wheelScroll
                className={sheetClass}
              >
                <p className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
                  {translate('components.native-chat.taskList.title', 'Tasks')}
                </p>
                <NativeChatTaskList list={list} presentation="sheet" />
              </PopoverContent>
            </Popover>
          ) : null}
          {listed.length > 0 ? (
            <Popover open={subagentsOpen} onOpenChange={setSubagentsOpen}>
              <PopoverAnchor virtualRef={columnRef} />
              <PopoverTrigger
                className={pillClass(subagentsOpen)}
                aria-label={translate(
                  'components.native-chat.activity.subagentsLabel',
                  '{{count}} subagents',
                  {
                    count: listed.length,
                    defaultValue_one: '{{count}} subagent'
                  }
                )}
              >
                <Users aria-hidden className="size-3.5 shrink-0" />
                <span>
                  {listed.length === 1
                    ? translate('components.native-chat.activity.subagent', '{{count}} subagent', {
                        count: listed.length
                      })
                    : translate(
                        'components.native-chat.activity.subagents',
                        '{{count}} subagents',
                        { count: listed.length }
                      )}
                </span>
                {working ? (
                  <span
                    aria-hidden
                    className="size-1.5 rounded-full bg-foreground animate-pulse motion-reduce:animate-none"
                  />
                ) : null}
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="top"
                collisionPadding={8}
                wheelScroll
                className={sheetClass}
              >
                <p className="border-b border-border px-3 py-2 text-xs font-medium text-foreground">
                  {translate('components.native-chat.activity.subagentsTitle', 'Subagents')}
                </p>
                <ul className="max-h-80 overflow-y-auto py-1">
                  {focused ? (
                    <li>
                      <SubagentChoice
                        label={translate('components.native-chat.activity.mainAgent', 'Main agent')}
                        detail={translate(
                          'components.native-chat.activity.backToConversation',
                          'Back to the conversation'
                        )}
                        current={false}
                        onChoose={() => {
                          setSubagentsOpen(false)
                          onFocusSubagent(null)
                        }}
                      />
                    </li>
                  ) : null}
                  {listed.map((agent) => (
                    <li key={agent.id}>
                      <SubagentChoice
                        agent={agent}
                        current={agent.id === focusedSubagentId}
                        onChoose={() => {
                          setSubagentsOpen(false)
                          onFocusSubagent(agent.id)
                        }}
                      />
                    </li>
                  ))}
                </ul>
              </PopoverContent>
            </Popover>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function SubagentChoice({
  agent,
  label,
  detail,
  current,
  onChoose
}: {
  agent?: NativeChatSubagentActivity
  label?: string
  detail?: string
  current: boolean
  onChoose: () => void
}): React.JSX.Element {
  const failed = agent?.state === 'failed' || agent?.state === 'stopped'
  return (
    <button
      type="button"
      aria-current={current ? 'true' : undefined}
      className={cn(
        'flex w-full flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        current && 'bg-accent'
      )}
      onClick={onChoose}
    >
      <span className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-medium">{label ?? agent?.label}</span>
        {agent ? (
          <span
            className={cn('shrink-0 text-xs text-muted-foreground', failed && 'text-chat-warning')}
          >
            {agent.state === 'failed' ? <Ban aria-hidden className="mr-1 inline size-3" /> : null}
            {stateLabel(agent.state)}
          </span>
        ) : null}
      </span>
      <span className="truncate text-xs text-muted-foreground">
        {detail ??
          agent?.activity ??
          translate('components.native-chat.activity.noActivity', 'No activity yet')}
      </span>
    </button>
  )
}

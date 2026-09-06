import React from 'react'
import { Bell, ExternalLink } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import CommentMarkdown from '../sidebar/CommentMarkdown'
import { EventTime, ThreadAgentStateIndicator } from './activity-thread-controls'
import { ActivityThreadHoverCard } from './activity-thread-hover-card'
import { activityThreadRowCopy } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'

// Why React.memo: rows are pure functions of these props; thread identity is stable across
// query/selection/group re-renders, so memo keeps a keystroke or selection change from
// re-rendering every mounted row. Callbacks take the thread so parents can pass stable handlers.
export const ActivityThreadRow = React.memo(function ActivityThreadRow({
  thread,
  selected,
  onSelect,
  onJump,
  onMarkRead,
  onMarkUnread,
  canJump,
  compactMode,
  disableMarkUnread = false,
  showJumpAction = true
}: {
  thread: AgentPaneThread
  selected: boolean
  onSelect: (thread: AgentPaneThread) => void
  onJump: (thread: AgentPaneThread) => void
  onMarkRead: (thread: AgentPaneThread) => void
  onMarkUnread: (thread: AgentPaneThread) => void
  canJump: boolean
  compactMode: boolean
  disableMarkUnread?: boolean
  showJumpAction?: boolean
}): React.JSX.Element {
  const { taskTitle, statusLine, statusKind, needsAttention, workspaceLabel } =
    activityThreadRowCopy(thread)
  const showMarkdownStatus = statusKind === 'message'
  const agentLabel = formatAgentTypeLabel(thread.agentType)

  return (
    <ActivityThreadHoverCard
      thread={thread}
      onJumpToWorkspace={onJump}
      canJumpToWorkspace={canJump}
    >
      <div
        data-current={selected ? 'true' : undefined}
        data-worktree-card-surface="true"
        data-worktree-card-active={selected ? 'primary' : undefined}
        onClick={() => onSelect(thread)}
        role="listitem"
        aria-label={taskTitle}
        aria-current={selected ? 'true' : undefined}
        className={cn(
          'group relative flex w-full cursor-pointer flex-col gap-1.5 rounded-lg border border-transparent px-1.5 py-2.5 text-left transition-[background-color,border-color,opacity,box-shadow] duration-200 outline-none select-none worktree-sidebar-card-hover focus-visible:ring-1 focus-visible:ring-ring',
          selected && 'border-transparent'
        )}
      >
        <div className="flex min-w-0 items-start gap-1.5">
          <span className="mt-0.5 inline-flex shrink-0">
            <ThreadAgentStateIndicator thread={thread} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {/* Keep the activation target separate from markdown links and row actions. */}
            <button
              type="button"
              aria-label={taskTitle}
              aria-keyshortcuts="Enter Space"
              onClick={(event) => {
                event.stopPropagation()
                onSelect(thread)
              }}
              className={cn(
                'block min-w-0 w-full cursor-pointer text-left text-[13px] leading-5 outline-none focus-visible:ring-1 focus-visible:ring-ring',
                compactMode ? 'truncate' : 'line-clamp-2 break-words',
                thread.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
              )}
              title={taskTitle}
            >
              {taskTitle}
            </button>

            {statusLine ? (
              showMarkdownStatus ? (
                <CommentMarkdown
                  content={statusLine}
                  className={cn(
                    'min-w-0 break-words text-[13px] leading-5 text-foreground/80',
                    compactMode ? 'line-clamp-2' : 'line-clamp-3',
                    '[&_*]:!m-0 [&_*]:!p-0 [&_br]:hidden [&_ol]:list-none [&_ul]:list-none'
                  )}
                  title={thread.responsePreview}
                />
              ) : (
                <div
                  className={cn(
                    'min-w-0 break-words text-[13px] leading-5',
                    compactMode ? 'line-clamp-2' : 'line-clamp-3',
                    needsAttention ? 'text-agent-question-text' : 'text-foreground/80'
                  )}
                  title={statusLine}
                >
                  {statusLine}
                </div>
              )
            ) : null}

            <div className="flex min-w-0 items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
              <span className="inline-flex shrink-0" title={agentLabel}>
                <AgentIcon agent={agentTypeToIconAgent(thread.agentType)} size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate" title={workspaceLabel}>
                {workspaceLabel}
              </span>
              {canJump && showJumpAction ? (
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center transition-opacity',
                    'can-hover:pointer-events-none can-hover:invisible can-hover:opacity-0',
                    'group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100'
                  )}
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="size-4 p-0 text-muted-foreground hover:text-foreground"
                        aria-label={translate(
                          'auto.components.activity.ActivityPrototypePage.4616ea39fd',
                          'Jump to workspace'
                        )}
                        onClick={(event) => {
                          event.stopPropagation()
                          onJump(thread)
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                      >
                        <ExternalLink className="size-2.5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {translate(
                        'auto.components.activity.ActivityPrototypePage.4616ea39fd',
                        'Jump to workspace'
                      )}
                    </TooltipContent>
                  </Tooltip>
                </span>
              ) : null}
              <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
                {thread.unread ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onMarkRead(thread)
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        className="flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded hover:bg-accent/80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        aria-label={translate(
                          'auto.components.activity.ActivityPrototypePage.markThreadRead',
                          'Mark thread as read'
                        )}
                      >
                        <FilledBellIcon
                          className="size-3 shrink-0 text-amber-500 drop-shadow-sm"
                          aria-hidden="true"
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {translate(
                        'auto.components.activity.ActivityPrototypePage.markThreadRead',
                        'Mark thread as read'
                      )}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={disableMarkUnread}
                        onClick={(event) => {
                          event.stopPropagation()
                          onMarkUnread(thread)
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        className={cn(
                          'flex size-3.5 shrink-0 cursor-pointer items-center justify-center rounded transition-opacity',
                          'can-hover:opacity-0 can-hover:group-hover:opacity-100',
                          'hover:bg-accent/80 active:scale-95',
                          'focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                        )}
                        aria-label={translate(
                          'auto.components.activity.ActivityPrototypePage.59b131fbd9',
                          'Mark thread unread'
                        )}
                      >
                        <Bell className="size-2.5 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="left">
                      {translate(
                        'auto.components.activity.ActivityPrototypePage.59b131fbd9',
                        'Mark thread unread'
                      )}
                    </TooltipContent>
                  </Tooltip>
                )}
              </span>
              <EventTime timestamp={thread.latestTimestamp} compact />
            </div>
          </div>
        </div>
      </div>
    </ActivityThreadHoverCard>
  )
})

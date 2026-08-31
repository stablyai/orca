import React from 'react'
import { Bell, ExternalLink } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { agentTypeToIconAgent, formatAgentTypeLabel } from '@/lib/agent-status'
import { getActivityThreadWorkspaceTitle } from '@/lib/activity-thread-display'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { FilledBellIcon } from '../sidebar/WorktreeCardHelpers'
import CommentMarkdown from '../sidebar/CommentMarkdown'
import {
  ActivityProjectLabel,
  EventTime,
  ThreadAgentStateIndicator
} from './activity-thread-controls'
import { activityThreadResponseRenderPreview } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'

function isEventFromNestedInteractiveElement(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const interactiveTarget = target.closest(
    'a, button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])'
  )
  return (
    interactiveTarget instanceof HTMLElement &&
    interactiveTarget !== currentTarget &&
    currentTarget.contains(interactiveTarget)
  )
}

export function ActivityThreadRow({
  thread,
  selected,
  onSelect,
  onJump,
  onMarkUnread,
  canJump,
  compactMode
}: {
  thread: AgentPaneThread
  selected: boolean
  onSelect: () => void
  onJump: () => void
  onMarkUnread: () => void
  canJump: boolean
  compactMode: boolean
}): React.JSX.Element {
  const renderedResponsePreview = activityThreadResponseRenderPreview({
    responsePreview: thread.responsePreview
  })
  const workspaceTitle = getActivityThreadWorkspaceTitle(thread.worktree)
  const taskTitle = thread.paneTitle
  const agentLabel = formatAgentTypeLabel(thread.agentType)
  const showStatusPreview =
    !compactMode &&
    renderedResponsePreview.length > 0 &&
    renderedResponsePreview !== taskTitle &&
    renderedResponsePreview !== workspaceTitle
  return (
    <div
      data-current={selected ? 'true' : undefined}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        // Why: markdown responses can contain links; keyboard activation on a nested link follows the link instead of selecting the row.
        if (isEventFromNestedInteractiveElement(event.target, event.currentTarget)) {
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        // Why (WorktreeCard cues): selected = tint+shadow, beats hover; unread = weight + left bar only; stacking all three confused selected vs unread on hover.
        // Why (asymmetric padding): title leading-snug adds ~3px above cap-height; smaller top pad evens the row.
        'group relative flex w-full cursor-pointer flex-col gap-1 border-b border-border px-3 pt-2.5 pb-3 text-left transition-colors',
        selected
          ? 'bg-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-white/[0.10] dark:shadow-[0_1px_2px_rgba(0,0,0,0.03)]'
          : 'hover:bg-accent/40'
      )}
    >
      {thread.unread ? (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />
      ) : null}
      <div className="flex min-w-0 items-start gap-2">
        <span className="inline-flex shrink-0 items-start gap-1">
          <ThreadAgentStateIndicator thread={thread} />
          <span className="inline-flex shrink-0 pt-px">
            <AgentIcon agent={agentTypeToIconAgent(thread.agentType)} size={14} />
          </span>
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <ActivityProjectLabel repo={thread.repo} />
              <div
                className={cn(
                  'min-w-0 text-[13px] leading-snug',
                  compactMode ? 'truncate' : 'line-clamp-2 break-words',
                  thread.unread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
                )}
                title={workspaceTitle}
              >
                {workspaceTitle}
              </div>
              {taskTitle !== workspaceTitle ? (
                <div
                  className={cn(
                    'min-w-0 text-[12px] leading-snug text-muted-foreground',
                    compactMode ? 'truncate' : 'line-clamp-2 break-words'
                  )}
                  title={taskTitle}
                >
                  {taskTitle}
                </div>
              ) : null}
              {showStatusPreview ? (
                <CommentMarkdown
                  content={renderedResponsePreview}
                  className={cn(
                    'h-[1lh] min-w-0 overflow-hidden truncate whitespace-nowrap text-[11px] font-normal leading-snug text-muted-foreground/80',
                    '[&_*]:inline [&_*]:!m-0 [&_*]:!p-0 [&_*]:!whitespace-nowrap [&_br]:hidden [&_ol]:list-none [&_ul]:list-none'
                  )}
                  title={thread.responsePreview}
                />
              ) : null}
              <div className="flex min-w-0 items-center gap-1.5 pt-0.5">
                <span className="shrink-0 text-[10px] text-muted-foreground/80">{agentLabel}</span>
                {canJump ? (
                  <span
                    className={cn(
                      'ml-auto inline-flex shrink-0 items-center transition-opacity',
                      'can-hover:pointer-events-none can-hover:invisible can-hover:opacity-0',
                      'group-hover:pointer-events-auto group-hover:visible group-hover:opacity-100'
                    )}
                  >
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="icon-xs"
                          aria-label={translate(
                            'auto.components.activity.ActivityPrototypePage.4616ea39fd',
                            'Jump to workspace'
                          )}
                          onClick={(event) => {
                            event.stopPropagation()
                            onJump()
                          }}
                          onMouseDown={(event) => event.stopPropagation()}
                        >
                          <ExternalLink className="size-3" />
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
              </div>
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 pt-px">
              <span className="inline-flex size-4 shrink-0 items-center justify-center">
                {thread.unread ? (
                  <FilledBellIcon
                    className="size-[13px] shrink-0 text-amber-500 drop-shadow-sm"
                    aria-label={translate(
                      'auto.components.activity.ActivityPrototypePage.beb2c19173',
                      'Unread'
                    )}
                  />
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation()
                          onMarkUnread()
                        }}
                        onMouseDown={(event) => event.stopPropagation()}
                        className={cn(
                          'group/unread flex size-4 shrink-0 cursor-pointer items-center justify-center rounded transition-all',
                          'hover:bg-accent/80 active:scale-95',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                        )}
                        aria-label={translate(
                          'auto.components.activity.ActivityPrototypePage.59b131fbd9',
                          'Mark thread unread'
                        )}
                      >
                        <Bell className="size-3 text-muted-foreground/40 can-hover:opacity-0 transition-opacity group-hover:opacity-100 group-hover/unread:opacity-100" />
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
              <EventTime timestamp={thread.latestTimestamp} />
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

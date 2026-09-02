import React from 'react'
import { CheckCheck, ListChecks, Search, Trash2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Toggle } from '@/components/ui/toggle'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { ActivityThreadOptionsMenu } from './activity-thread-controls'
import type { ActivityGroupBy, ThreadReadFilter } from './activity-thread-types'

export function ActivityThreadListToolbar({
  activityFilterInputRef,
  query,
  onQueryChange,
  groupBy,
  onGroupByChange,
  readFilter,
  onReadFilterChange,
  compactMode,
  showChildAgents,
  hasUnreadThreads,
  onCompactModeChange,
  onShowChildAgentsChange,
  onMarkAllThreadsRead,
  hasCompletedThreads,
  onClearCompleted,
  resizable,
  showFilterControls,
  showOptionsMenu,
  showInlineActions = true
}: {
  activityFilterInputRef: React.RefObject<HTMLInputElement | null>
  query: string
  onQueryChange: (query: string) => void
  groupBy: ActivityGroupBy
  onGroupByChange: (groupBy: ActivityGroupBy) => void
  readFilter: ThreadReadFilter
  onReadFilterChange: (readFilter: ThreadReadFilter) => void
  compactMode: boolean
  showChildAgents?: boolean
  hasUnreadThreads: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onShowChildAgentsChange?: (showChildAgents: boolean) => void
  onMarkAllThreadsRead?: () => void
  hasCompletedThreads?: boolean
  onClearCompleted?: () => void
  resizable: boolean
  showFilterControls: boolean
  showOptionsMenu: boolean
  showInlineActions?: boolean
}): React.JSX.Element | null {
  const showToolbar = showFilterControls || showOptionsMenu
  if (!showToolbar) {
    return null
  }

  return (
    <>
      <div className="shrink-0 border-b border-border px-2 py-1.5">
        <div className="flex items-center justify-end gap-1">
          {showFilterControls ? (
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={activityFilterInputRef}
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
                placeholder={translate(
                  'auto.components.activity.ActivityPrototypePage.795cbf26e2',
                  'Filter...'
                )}
                className={cn('h-7 w-full pl-6 text-[11px]', query ? 'pr-6' : '')}
              />
              {query ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="absolute right-0.5 top-1/2 -translate-y-1/2 size-5 p-0 text-muted-foreground hover:text-foreground"
                  aria-label={translate(
                    'auto.components.sidebar.WorkspaceKanbanSearchField.3b7ea51793',
                    'Clear search'
                  )}
                  onClick={() => {
                    onQueryChange('')
                    activityFilterInputRef.current?.focus()
                  }}
                >
                  <X className="size-2.5" />
                </Button>
              ) : null}
            </div>
          ) : null}
          {resizable ? (
            <Select
              value={groupBy}
              onValueChange={(value) => onGroupByChange(value as ActivityGroupBy)}
            >
              <SelectTrigger
                size="sm"
                className="h-7 w-[116px] shrink-0 px-2 text-[11px]"
                aria-label={translate(
                  'auto.components.activity.ActivityPrototypePage.770d458144',
                  'Group agent activity by'
                )}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                <SelectItem value="none">
                  {translate('auto.components.activity.ActivityPrototypePage.none', 'None')}
                </SelectItem>
                <SelectItem value="status">
                  {translate('auto.components.activity.ActivityPrototypePage.4a3986b200', 'Status')}
                </SelectItem>
                <SelectItem value="project">
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.8c3b621ddf',
                    'Project'
                  )}
                </SelectItem>
                <SelectItem value="worktree">
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.b29191b3e0',
                    'Worktree'
                  )}
                </SelectItem>
                <SelectItem value="agent">
                  {translate('auto.components.activity.ActivityPrototypePage.f6396e1f85', 'Agent')}
                </SelectItem>
              </SelectContent>
            </Select>
          ) : null}
          {showFilterControls ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Toggle
                  pressed={readFilter === 'unread'}
                  onPressedChange={(pressed) => onReadFilterChange(pressed ? 'unread' : 'all')}
                  size="sm"
                  className={cn(
                    'size-7 shrink-0 p-0 rounded-md transition-all',
                    readFilter === 'unread'
                      ? '!border border-primary/30 !bg-primary/10 !text-primary/90 shadow-xs hover:!bg-primary/15 hover:!text-primary'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                  )}
                  aria-label={translate(
                    'auto.components.activity.ActivityPrototypePage.d1a88df9a8',
                    'Show unread threads only'
                  )}
                >
                  <ListChecks className="size-3.5" strokeWidth={2.25} />
                </Toggle>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                {translate(
                  'auto.components.activity.ActivityPrototypePage.d1a88df9a8',
                  'Show unread threads only'
                )}
              </TooltipContent>
            </Tooltip>
          ) : null}
          {showOptionsMenu ? (
            <ActivityThreadOptionsMenu
              groupBy={groupBy}
              onGroupByChange={onGroupByChange}
              compactMode={compactMode}
              showChildAgents={showChildAgents}
              hasUnreadThreads={hasUnreadThreads}
              hasCompletedThreads={hasCompletedThreads}
              onCompactModeChange={onCompactModeChange}
              onShowChildAgentsChange={onShowChildAgentsChange}
              onMarkAllThreadsRead={onMarkAllThreadsRead}
              onClearCompleted={onClearCompleted}
            />
          ) : null}
        </div>
      </div>
      {showInlineActions && (onMarkAllThreadsRead || onClearCompleted) ? (
        <div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
          {onMarkAllThreadsRead ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onMarkAllThreadsRead}
              disabled={!hasUnreadThreads}
            >
              <CheckCheck className="size-3.5" />
              <span>
                {translate(
                  'auto.components.activity.ActivityPrototypePage.023ff75afe',
                  'Mark all read'
                )}
              </span>
            </Button>
          ) : null}
          {onClearCompleted ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 gap-1 px-2 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={onClearCompleted}
              disabled={!hasCompletedThreads}
            >
              <Trash2 className="size-3.5" />
              <span>
                {translate(
                  'auto.components.activity.ActivityPrototypePage.clearCompleted',
                  'Clear completed'
                )}
              </span>
            </Button>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

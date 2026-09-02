import React from 'react'
import {
  Check,
  CheckCheck,
  GitFork,
  Layers,
  ListChecks,
  ListFilter,
  Rows3,
  Search,
  Trash2
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ActivityScopeFilterMenuSections } from './activity-scope-filter-controls'
import type { ActivityGroupBy } from './activity-thread-types'

const ALIGNED_CHECKBOX_ITEM_CLASS = 'pl-2 [&>span.absolute]:hidden'

function getActivityGroupByLabel(groupBy: ActivityGroupBy): string {
  switch (groupBy) {
    case 'none':
      return translate('auto.components.activity.ActivityPrototypePage.none', 'None')
    case 'status':
      return translate('auto.components.activity.ActivityPrototypePage.4a3986b200', 'Status')
    case 'project':
      return translate('auto.components.activity.ActivityPrototypePage.8c3b621ddf', 'Project')
    case 'worktree':
      return translate('auto.components.activity.ActivityPrototypePage.b29191b3e0', 'Worktree')
    case 'agent':
      return translate('auto.components.activity.ActivityPrototypePage.f6396e1f85', 'Agent')
  }
}

export function ActivityThreadOptionsMenu({
  groupBy,
  onGroupByChange,
  compactMode,
  showChildAgents = false,
  hasUnreadThreads,
  hasCompletedThreads = false,
  onCompactModeChange,
  onShowChildAgentsChange,
  onMarkAllThreadsRead,
  onClearCompleted,
  onSearch,
  unreadOnly = false,
  onToggleUnread
}: {
  groupBy?: ActivityGroupBy
  onGroupByChange?: (groupBy: ActivityGroupBy) => void
  compactMode: boolean
  showChildAgents?: boolean
  hasUnreadThreads: boolean
  hasCompletedThreads?: boolean
  onCompactModeChange: (compactMode: boolean) => void
  onShowChildAgentsChange?: (showChildAgents: boolean) => void
  onMarkAllThreadsRead?: () => void
  onClearCompleted?: () => void
  onSearch?: () => void
  unreadOnly?: boolean
  onToggleUnread?: () => void
}): React.JSX.Element {
  const skipCloseAutoFocusRef = React.useRef(false)

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          {/* Why: keep Tooltip and Dropdown from composing refs onto the same button (Radix setRef crash loop). */}
          <span className="inline-flex shrink-0">
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={translate(
                  'auto.components.activity.ActivityPrototypePage.db8a1878b5',
                  'Thread list options'
                )}
              >
                <ListFilter className="size-3.5" strokeWidth={2.25} />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {translate(
            'auto.components.activity.ActivityPrototypePage.activityOptions',
            'Activity options'
          )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-56"
        onCloseAutoFocus={(event) => {
          if (skipCloseAutoFocusRef.current) {
            event.preventDefault()
            skipCloseAutoFocusRef.current = false
          }
        }}
      >
        {onSearch || onToggleUnread ? (
          <>
            {onSearch ? (
              <DropdownMenuItem
                onSelect={() => {
                  skipCloseAutoFocusRef.current = true
                  onSearch()
                }}
              >
                <Search className="size-3.5 text-muted-foreground" />
                <span>
                  {translate('auto.components.activity.ActivityPrototypePage.search', 'Search')}
                </span>
              </DropdownMenuItem>
            ) : null}
            {onToggleUnread ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuCheckboxItem
                    checked={unreadOnly}
                    className={ALIGNED_CHECKBOX_ITEM_CLASS}
                    onCheckedChange={() => onToggleUnread()}
                    onSelect={(event) => event.preventDefault()}
                  >
                    <ListChecks className="size-3.5 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate">
                      {translate(
                        'auto.components.activity.ActivityPrototypePage.showUnreadOnly',
                        'Show unread only'
                      )}
                    </span>
                    {hasUnreadThreads ? (
                      <span
                        className="size-1.5 shrink-0 rounded-full bg-primary"
                        aria-hidden="true"
                        data-unread-dot=""
                      />
                    ) : null}
                    {unreadOnly ? <Check className="size-3.5" /> : null}
                  </DropdownMenuCheckboxItem>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.unreadOnlyDescription',
                    'Filters the activity list to show only threads with unread updates.'
                  )}
                </TooltipContent>
              </Tooltip>
            ) : null}
            <DropdownMenuSeparator />
          </>
        ) : null}
        <ActivityScopeFilterMenuSections />
        {groupBy && onGroupByChange ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Layers className="size-3.5 text-muted-foreground" />
              <span className="flex flex-1 items-center justify-between gap-2">
                <span>
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.770d458144',
                    'Group by'
                  )}
                </span>
                <span className="text-[11px] font-medium text-muted-foreground">
                  {getActivityGroupByLabel(groupBy)}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              <DropdownMenuRadioGroup
                value={groupBy}
                onValueChange={(value) => onGroupByChange(value as ActivityGroupBy)}
              >
                {[
                  ['none', 'None', 'auto.components.activity.ActivityPrototypePage.none'],
                  ['status', 'Status', 'auto.components.activity.ActivityPrototypePage.4a3986b200'],
                  [
                    'project',
                    'Project',
                    'auto.components.activity.ActivityPrototypePage.8c3b621ddf'
                  ],
                  [
                    'worktree',
                    'Worktree',
                    'auto.components.activity.ActivityPrototypePage.b29191b3e0'
                  ],
                  ['agent', 'Agent', 'auto.components.activity.ActivityPrototypePage.f6396e1f85']
                ].map(([value, label, key]) => (
                  <DropdownMenuRadioItem
                    key={value}
                    value={value}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {translate(key, label)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuCheckboxItem
              checked={compactMode}
              className={ALIGNED_CHECKBOX_ITEM_CLASS}
              onCheckedChange={(checked) => onCompactModeChange(checked === true)}
              onSelect={(event) => event.preventDefault()}
            >
              <Rows3 className="size-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {translate(
                  'auto.components.activity.ActivityPrototypePage.f70e4bec47',
                  'Compact mode'
                )}
              </span>
              {compactMode ? <Check className="size-3.5" /> : null}
            </DropdownMenuCheckboxItem>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={8}>
            {translate(
              'auto.components.activity.ActivityPrototypePage.compactModeDescription',
              'Shows shorter thread rows with one-line titles and two-line status messages.'
            )}
          </TooltipContent>
        </Tooltip>
        {onShowChildAgentsChange ? (
          <DropdownMenuCheckboxItem
            checked={showChildAgents}
            className={ALIGNED_CHECKBOX_ITEM_CLASS}
            onCheckedChange={(checked) => onShowChildAgentsChange(checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            <GitFork className="size-3.5 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">
              {translate(
                'auto.components.activity.ActivityPrototypePage.showChildAgents',
                'Show child agents'
              )}
            </span>
            {showChildAgents ? <Check className="size-3.5" /> : null}
          </DropdownMenuCheckboxItem>
        ) : null}
        {onMarkAllThreadsRead || onClearCompleted ? (
          <>
            <DropdownMenuSeparator />
            {onMarkAllThreadsRead ? (
              <DropdownMenuItem onSelect={onMarkAllThreadsRead} disabled={!hasUnreadThreads}>
                <CheckCheck className="size-3.5 text-muted-foreground" />
                <span>
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.023ff75afe',
                    'Mark all read'
                  )}
                </span>
              </DropdownMenuItem>
            ) : null}
            {onClearCompleted ? (
              <DropdownMenuItem onSelect={onClearCompleted} disabled={!hasCompletedThreads}>
                <Trash2 className="size-3.5 text-muted-foreground" />
                <span>
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.clearCompleted',
                    'Clear completed'
                  )}
                </span>
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

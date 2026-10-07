import React from 'react'
import { CheckCheck, SlidersHorizontal, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
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
import {
  formatActiveFilterLabel,
  OptionsFilterCountBadge
} from '@/components/sidebar/options-filter-count-badge'
import {
  ActivityScopeFilterMenuItems,
  useActivityScopeFilterCount
} from './activity-scope-filter-controls'
import type { ActivityGroupBy } from './activity-thread-types'

const GROUP_BY_OPTIONS = [
  'none',
  'status',
  'project',
  'worktree',
  'agent'
] as const satisfies readonly ActivityGroupBy[]

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
  showSearch = false,
  onShowSearchChange,
  unreadOnly = false,
  onUnreadOnlyChange
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
  showSearch?: boolean
  onShowSearchChange?: (showSearch: boolean) => void
  unreadOnly?: boolean
  onUnreadOnlyChange?: (unreadOnly: boolean) => void
}): React.JSX.Element {
  const skipCloseAutoFocusRef = React.useRef(false)
  const activeFilterCount =
    useActivityScopeFilterCount() + (onUnreadOnlyChange && unreadOnly ? 1 : 0)
  const activeFilterLabel = formatActiveFilterLabel(activeFilterCount)
  const optionsLabel =
    activeFilterCount > 0
      ? translate(
          'auto.components.activity.ActivityPrototypePage.threadListOptionsActive',
          'Thread list options ({{value0}} active)',
          { value0: activeFilterLabel }
        )
      : translate(
          'auto.components.activity.ActivityPrototypePage.db8a1878b5',
          'Thread list options'
        )

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
                className="relative text-muted-foreground"
                aria-label={optionsLabel}
              >
                <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
                <OptionsFilterCountBadge count={activeFilterCount} />
              </Button>
            </DropdownMenuTrigger>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {activeFilterCount > 0
            ? translate(
                'auto.components.activity.ActivityPrototypePage.activityOptionsActive',
                'Activity options ({{value0}})',
                { value0: activeFilterLabel }
              )
            : translate(
                'auto.components.activity.ActivityPrototypePage.activityOptions',
                'Activity options'
              )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-60"
        onCloseAutoFocus={(event) => {
          if (skipCloseAutoFocusRef.current) {
            event.preventDefault()
            skipCloseAutoFocusRef.current = false
          }
        }}
      >
        <DropdownMenuLabel>
          {translate('auto.components.activity.ActivityPrototypePage.filtersSection', 'Filters')}
        </DropdownMenuLabel>
        {onUnreadOnlyChange ? (
          <DropdownMenuCheckboxItem
            checked={unreadOnly}
            onCheckedChange={(checked) => onUnreadOnlyChange(checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {translate(
              'auto.components.activity.ActivityPrototypePage.showUnreadOnly',
              'Show unread only'
            )}
          </DropdownMenuCheckboxItem>
        ) : null}
        {onShowChildAgentsChange ? (
          <DropdownMenuCheckboxItem
            checked={showChildAgents}
            onCheckedChange={(checked) => onShowChildAgentsChange(checked === true)}
            onSelect={(event) => event.preventDefault()}
          >
            {translate(
              'auto.components.activity.ActivityPrototypePage.showChildAgents',
              'Show child agents'
            )}
          </DropdownMenuCheckboxItem>
        ) : null}
        <ActivityScopeFilterMenuItems />
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.activity.ActivityPrototypePage.viewSection', 'View')}
        </DropdownMenuLabel>
        {groupBy && onGroupByChange ? (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <span className="flex flex-1 items-center justify-between gap-3">
                <span>
                  {translate(
                    'auto.components.activity.ActivityPrototypePage.770d458144',
                    'Group by'
                  )}
                </span>
                <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground">
                  {getActivityGroupByLabel(groupBy)}
                </span>
              </span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-40">
              <DropdownMenuRadioGroup
                value={groupBy}
                onValueChange={(value) => onGroupByChange(value as ActivityGroupBy)}
              >
                {GROUP_BY_OPTIONS.map((value) => (
                  <DropdownMenuRadioItem
                    key={value}
                    value={value}
                    onSelect={(event) => event.preventDefault()}
                  >
                    {getActivityGroupByLabel(value)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ) : null}
        <DropdownMenuCheckboxItem
          checked={compactMode}
          onCheckedChange={(checked) => onCompactModeChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate('auto.components.activity.ActivityPrototypePage.f70e4bec47', 'Compact mode')}
        </DropdownMenuCheckboxItem>
        {onShowSearchChange ? (
          <DropdownMenuCheckboxItem
            checked={showSearch}
            onCheckedChange={(checked) => {
              const show = checked === true
              skipCloseAutoFocusRef.current = show
              onShowSearchChange(show)
            }}
          >
            {translate('auto.components.activity.ActivityPrototypePage.showSearch', 'Show search')}
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

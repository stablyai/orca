import React from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { formatActiveFilterLabel } from '../../../../../shared/workspace-view/workspace-row-filters'
import { OptionsFilterCountBadge } from '../../sidebar/options-filter-count-badge'
import {
  getPRCommentsListDisplayModeLabel,
  PR_COMMENT_LIST_DISPLAY_MODES,
  type PRCommentsListDisplayMode
} from './use-comments-list-state'

export function PRCommentOptionsMenu({
  displayMode,
  hideResolved,
  onDisplayModeChange,
  onHideResolvedChange
}: {
  displayMode: PRCommentsListDisplayMode
  hideResolved: boolean
  onDisplayModeChange: (mode: PRCommentsListDisplayMode) => void
  onHideResolvedChange: (hide: boolean) => void
}): React.JSX.Element {
  const activeFilterCount = hideResolved ? 1 : 0
  const label =
    activeFilterCount > 0
      ? translate(
          'auto.components.right.sidebar.checks.panel.commentOptions.triggerActive',
          'Comment options ({{value0}})',
          { value0: formatActiveFilterLabel(activeFilterCount) }
        )
      : translate(
          'auto.components.right.sidebar.checks.panel.commentOptions.title',
          'Comment options'
        )
  return (
    <DropdownMenu modal={false}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="relative"
              aria-label={label}
            >
              <SlidersHorizontal className="size-3 text-muted-foreground" />
              <OptionsFilterCountBadge count={activeFilterCount} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {label}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="w-60">
        <div className="px-2 pt-1.5 text-sm font-semibold text-foreground">
          {translate(
            'auto.components.right.sidebar.checks.panel.commentOptions.title',
            'Comment options'
          )}
        </div>
        {/* Menu-native items: Radix menus block Tab and arrow-key only between items. */}
        <DropdownMenuLabel>
          {translate('auto.components.right.sidebar.checks.panel.content.5e6e5a13fa', 'View')}
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={displayMode}
          onValueChange={(value) => {
            const next = PR_COMMENT_LIST_DISPLAY_MODES.find((mode) => mode === value)
            if (next) {
              onDisplayModeChange(next)
            }
          }}
        >
          {PR_COMMENT_LIST_DISPLAY_MODES.map((mode) => (
            <DropdownMenuRadioItem
              key={mode}
              value={mode}
              onSelect={(event) => event.preventDefault()}
            >
              {getPRCommentsListDisplayModeLabel(mode)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>
          {translate('auto.components.sidebar.SidebarWorkspaceFilterSection.82594419ba', 'Filters')}
        </DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={hideResolved}
          onCheckedChange={(checked) => onHideResolvedChange(checked === true)}
          onSelect={(event) => event.preventDefault()}
        >
          {translate(
            'auto.components.right.sidebar.checks.panel.commentOptions.hideResolved',
            'Hide resolved threads'
          )}
        </DropdownMenuCheckboxItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

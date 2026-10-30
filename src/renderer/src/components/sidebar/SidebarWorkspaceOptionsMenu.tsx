import React, { useCallback, useState } from 'react'
import { SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { OptionsFilterCountBadge } from './options-filter-count-badge'
import {
  useWorkspaceOptionsFilterBadge,
  WorkspaceOptionsMenuItems
} from './workspace-options-menu-items'

type SidebarWorkspaceOptionsMenuProps = {
  preserveWorkspaceBoardOpen?: boolean
  onMenuOpenChange?: (open: boolean) => void
}

const SidebarWorkspaceOptionsMenu = React.memo(function SidebarWorkspaceOptionsMenu({
  preserveWorkspaceBoardOpen = false,
  onMenuOpenChange
}: SidebarWorkspaceOptionsMenuProps) {
  useUiLanguageRevision()
  const [open, setOpen] = useState(false)
  const { hasAnyFilter, activeFilterCount } = useWorkspaceOptionsFilterBadge()

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      onMenuOpenChange?.(next)
    },
    [onMenuOpenChange]
  )

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="relative text-muted-foreground"
              aria-label={
                hasAnyFilter
                  ? translate(
                      'auto.components.sidebar.SidebarWorkspaceOptionsMenu.optionsActiveFilters',
                      'Workspace options ({{count}} filters active)',
                      {
                        count: activeFilterCount,
                        defaultValue_one: 'Workspace options ({{count}} filter active)'
                      }
                    )
                  : translate(
                      'auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082',
                      'Workspace options'
                    )
              }
              data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
            >
              <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
              <OptionsFilterCountBadge count={activeFilterCount} />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {hasAnyFilter
            ? translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.optionsFilterCount',
                'Workspace options ({{count}} filters)',
                {
                  count: activeFilterCount,
                  defaultValue_one: 'Workspace options ({{count}} filter)'
                }
              )
            : translate(
                'auto.components.sidebar.SidebarWorkspaceOptionsMenu.9919ae1082',
                'Workspace options'
              )}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 pb-2"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <WorkspaceOptionsMenuItems preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export default SidebarWorkspaceOptionsMenu

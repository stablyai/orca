import React, { useCallback, useState } from 'react'
import { Ellipsis, FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import { SidebarCountBadge } from './sidebar-count-badge'
import {
  useWorkspaceOptionsFilterBadge,
  WorkspaceOptionsMenuItems
} from './workspace-options-menu-items'

export const SIDEBAR_HEADER_WIDE_MIN_WIDTH = 235

function CompactWorkspaceOverflow({
  preserveWorkspaceBoardOpen,
  onMenuOpenChange
}: {
  preserveWorkspaceBoardOpen: boolean
  onMenuOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const [open, setOpen] = useState(false)
  const { hasAnyFilter, activeFilterCount } = useWorkspaceOptionsFilterBadge()
  const boardAttr = preserveWorkspaceBoardOpen ? '' : undefined

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
              aria-label={translate(
                'auto.components.sidebar.SidebarHeader.moreActions',
                'More workspace actions'
              )}
              data-workspace-board-preserve-open={boardAttr}
            >
              <Ellipsis className="size-3.5" strokeWidth={2.25} />
              {hasAnyFilter ? <SidebarCountBadge count={activeFilterCount} /> : null}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate('auto.components.sidebar.SidebarHeader.moreActions', 'More workspace actions')}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side="right"
        align="start"
        sideOffset={8}
        className="w-72 pb-2"
        data-workspace-board-preserve-open={boardAttr}
      >
        <WorkspaceOptionsMenuItems preserveWorkspaceBoardOpen={preserveWorkspaceBoardOpen} />
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => openModal('add-repo')}>
          <FolderPlus className="size-3.5" strokeWidth={2.25} />
          {translate('auto.components.sidebar.SidebarHeader.25a95899c9', 'Add Project')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function SidebarHeaderActions({
  onWorkspaceBoardMenuOpenChange,
  hideWorkspaceOptions = false
}: {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  hideWorkspaceOptions?: boolean
}): React.JSX.Element {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const newWorktreeShortcutLabel = useShortcutLabel('workspace.create')
  const compact = sidebarWidth < SIDEBAR_HEADER_WIDE_MIN_WIDTH

  if (compact) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              className="text-muted-foreground"
              onClick={openWorkspaceCreationComposerWithTourHandoff}
              aria-label={translate(
                'auto.components.sidebar.SidebarHeader.92154beb7e',
                'New workspace'
              )}
              data-contextual-tour-target="workspace-create-control"
            >
              <Plus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate(
              'auto.components.sidebar.SidebarHeader.ca6f729da2',
              'New workspace ({{value0}})',
              { value0: newWorktreeShortcutLabel }
            )}
          </TooltipContent>
        </Tooltip>
        {hideWorkspaceOptions ? null : (
          <CompactWorkspaceOverflow
            preserveWorkspaceBoardOpen
            onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
          />
        )}
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-1">
      {hideWorkspaceOptions ? null : (
        <SidebarWorkspaceOptionsMenu
          preserveWorkspaceBoardOpen
          onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
        />
      )}

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            type="button"
            className="text-muted-foreground"
            // Why: the parallel-work tour must click the real sidebar
            // control so it can hand off to the workspace-creation tour.
            onClick={openWorkspaceCreationComposerWithTourHandoff}
            aria-label={translate(
              'auto.components.sidebar.SidebarHeader.92154beb7e',
              'New workspace'
            )}
            data-contextual-tour-target="workspace-create-control"
          >
            <Plus className="size-3.5" strokeWidth={2.25} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {translate(
            'auto.components.sidebar.SidebarHeader.ca6f729da2',
            'New workspace ({{value0}})',
            { value0: newWorktreeShortcutLabel }
          )}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

import React, { useCallback, useState } from 'react'
import { Ellipsis, FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { formatOptionalPrimaryShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import { SidebarCountBadge } from './sidebar-count-badge'
import { SidebarClientScopeSwitcher } from './SidebarClientScopeSwitcher'
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
                'auto.components.sidebar.SidebarHeader.a52adae158',
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
          {translate('auto.components.sidebar.SidebarHeader.a52adae158', 'More workspace actions')}
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function AddProjectButton({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element {
  const openModal = useAppStore((s) => s.openModal)
  const label = translate('auto.components.sidebar.SidebarHeader.addProject', 'Add project')

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="text-muted-foreground"
          aria-label={label}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          onClick={() => openModal('add-repo')}
        >
          <FolderPlus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}

function NewWorkspaceButton({
  preserveWorkspaceBoardOpen
}: {
  preserveWorkspaceBoardOpen: boolean
}): React.JSX.Element {
  const keybindings = useAppStore((s) => s.keybindings)
  // Why primary: workspace.create binds both Mod+N and Mod+Shift+N, and listing
  // every alias in a one-line tooltip reads as noise rather than help.
  const shortcutLabel = formatOptionalPrimaryShortcutLabel('workspace.create', keybindings)
  const label = translate('auto.components.sidebar.SidebarHeader.92154beb7e', 'New workspace')

  // Why the tour handoff here: the tour highlights this button, and it is now
  // the control that performs the action rather than one that opens a menu.
  const handleCreateWorkspace = useCallback(() => {
    openWorkspaceCreationComposerWithTourHandoff()
  }, [])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          type="button"
          className="text-muted-foreground"
          aria-label={label}
          data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
          data-contextual-tour-target="workspace-create-control"
          onClick={handleCreateWorkspace}
        >
          <Plus className="size-3.5" strokeWidth={2.25} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {label}
        {shortcutLabel ? <span className="ml-1.5 text-background/60">{shortcutLabel}</span> : null}
      </TooltipContent>
    </Tooltip>
  )
}

export function SidebarHeaderActions({
  onWorkspaceBoardMenuOpenChange,
  agentsViewActive = false
}: {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  agentsViewActive?: boolean
}): React.JSX.Element {
  const sidebarWidth = useAppStore((s) => s.sidebarWidth)
  const compact = sidebarWidth < SIDEBAR_HEADER_WIDE_MIN_WIDTH

  if (compact) {
    return (
      <div className="flex shrink-0 items-center gap-1" data-sidebar-header-actions="">
        {agentsViewActive ? null : <SidebarClientScopeSwitcher />}
        <NewWorkspaceButton preserveWorkspaceBoardOpen />
        {agentsViewActive ? null : (
          <>
            <AddProjectButton preserveWorkspaceBoardOpen />
            <CompactWorkspaceOverflow
              preserveWorkspaceBoardOpen
              onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
            />
          </>
        )}
      </div>
    )
  }

  return (
    <div className="flex shrink-0 items-center gap-1" data-sidebar-header-actions="">
      {/* Why both hidden in the agents view: it lists activity, not projects. */}
      {agentsViewActive ? null : (
        <>
          <SidebarClientScopeSwitcher />
          <SidebarWorkspaceOptionsMenu
            preserveWorkspaceBoardOpen
            onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
          />
          <AddProjectButton preserveWorkspaceBoardOpen />
        </>
      )}
      <NewWorkspaceButton preserveWorkspaceBoardOpen />
    </div>
  )
}

import React from 'react'
import { ChevronsDownUp, ChevronsUpDown, FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import { translate } from '@/i18n/i18n'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange
}: SidebarHeaderProps) {
  const openModal = useAppStore((s) => s.openModal)
  const newWorktreeShortcutLabel = useShortcutLabel('workspace.create')
  const groupBy = useAppStore((s) => s.groupBy)
  const canCreateWorkspace = useAppStore((s) => s.repos.length > 0)
  const sidebarTitle = groupBy === 'repo' ? 'Projects' : 'Workspaces'
  const hasCollapsibleGroups = useAppStore((s) => s.sidebarVisibleGroupKeys.length > 0)
  const allGroupsCollapsed = useAppStore((s) => s.sidebarVisibleGroupsAllCollapsed)
  const toggleAllCollapsedGroups = useAppStore((s) => s.toggleAllCollapsedGroups)
  const collapseToggleLabel = allGroupsCollapsed
    ? translate('auto.components.sidebar.SidebarHeader.ae1097f309', 'Expand All Groups')
    : translate('auto.components.sidebar.SidebarHeader.ec1e5538bb', 'Collapse All Groups')

  return (
    <div className="mt-2 flex h-8 items-center justify-between px-2 gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <span
          className="pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none"
          data-sidebar-section-title={groupBy === 'repo' ? 'projects' : 'workspaces'}
        >
          {sidebarTitle}
        </span>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className={cn(
                'text-muted-foreground',
                !hasCollapsibleGroups && 'cursor-not-allowed opacity-50'
              )}
              aria-label={collapseToggleLabel}
              aria-disabled={!hasCollapsibleGroups}
              // Why: native disabled buttons suppress Radix tooltip triggers in Chromium.
              onClick={() => {
                if (!hasCollapsibleGroups) {
                  return
                }
                toggleAllCollapsedGroups()
              }}
            >
              {allGroupsCollapsed ? (
                <ChevronsUpDown className="size-3.5" strokeWidth={2.25} />
              ) : (
                <ChevronsDownUp className="size-3.5" strokeWidth={2.25} />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {collapseToggleLabel}
          </TooltipContent>
        </Tooltip>

        <SidebarWorkspaceOptionsMenu
          preserveWorkspaceBoardOpen
          onMenuOpenChange={onWorkspaceBoardMenuOpenChange}
        />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              aria-label={translate(
                'auto.components.sidebar.SidebarHeader.25a95899c9',
                'Add Project'
              )}
              onClick={() => openModal('add-repo')}
            >
              <FolderPlus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {translate('auto.components.sidebar.SidebarHeader.25a95899c9', 'Add Project')}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={() => {
                if (!canCreateWorkspace) {
                  return
                }
                // Why: the parallel-work tour must click the real sidebar
                // control so it can hand off to the workspace-creation tour.
                openWorkspaceCreationComposerWithTourHandoff()
              }}
              aria-label={translate(
                'auto.components.sidebar.SidebarHeader.92154beb7e',
                'New workspace'
              )}
              disabled={!canCreateWorkspace}
              data-contextual-tour-target="workspace-create-control"
            >
              <Plus className="size-3.5" strokeWidth={2.25} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={6}>
            {canCreateWorkspace
              ? translate(
                  'auto.components.sidebar.SidebarHeader.ca6f729da2',
                  'New workspace ({{value0}})',
                  { value0: newWorktreeShortcutLabel }
                )
              : translate(
                  'auto.components.sidebar.SidebarHeader.5c9c7c16aa',
                  'Add a project to create workspaces'
                )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarHeader

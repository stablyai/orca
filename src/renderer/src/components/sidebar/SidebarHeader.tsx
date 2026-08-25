import React from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
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
  const sidebarViewMode = useAppStore((s) => s.sidebarViewMode)
  const setSidebarViewMode = useAppStore((s) => s.setSidebarViewMode)

  return (
    <div className="mt-2 flex h-8 items-center justify-between px-2 gap-2">
      <div className="flex min-w-0 items-center gap-1">
        <ToggleGroup
          type="single"
          value={sidebarViewMode}
          onValueChange={(value) => {
            if (value === 'project' || value === 'current') {
              setSidebarViewMode(value)
            }
          }}
          variant="outline"
          size="sm"
          className="h-6"
          data-sidebar-section-title={groupBy === 'repo' ? 'projects' : 'workspaces'}
        >
          <ToggleGroupItem
            value="project"
            className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
          >
            {translate('auto.components.sidebar.SidebarHeader.viewMode.project', 'Project')}
          </ToggleGroupItem>
          <ToggleGroupItem
            value="current"
            className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
          >
            {translate('auto.components.sidebar.SidebarHeader.viewMode.current', 'Current')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
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
          <TooltipContent side="right" sideOffset={6}>
            {translate(
              'auto.components.sidebar.SidebarHeader.ca6f729da2',
              'New workspace ({{value0}})',
              { value0: newWorktreeShortcutLabel }
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
})

export default SidebarHeader

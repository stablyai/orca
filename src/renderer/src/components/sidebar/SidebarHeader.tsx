import React from 'react'
import { FolderPlus, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

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
  const sidebarListMode = useAppStore((s) => s.sidebarListMode)
  const setSidebarListMode = useAppStore((s) => s.setSidebarListMode)
  const projectsTitle =
    groupBy === 'repo'
      ? translate('auto.components.sidebar.SidebarHeader.d2a0089e45', 'Projects')
      : translate('auto.components.sidebar.SidebarHeader.b6cd1198f2', 'Workspaces')

  return (
    <div className="mt-2 flex h-8 items-center justify-between px-2 gap-2">
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          className={cn(
            'pl-2 text-xs font-semibold select-none',
            sidebarListMode === 'projects'
              ? 'text-muted-foreground/80'
              : 'text-muted-foreground/40 hover:text-muted-foreground/70'
          )}
          aria-pressed={sidebarListMode === 'projects'}
          data-sidebar-section-title={groupBy === 'repo' ? 'projects' : 'workspaces'}
          onClick={() => setSidebarListMode('projects')}
        >
          {projectsTitle}
        </button>
        <button
          type="button"
          className={cn(
            'text-xs font-semibold select-none',
            sidebarListMode === 'missions'
              ? 'text-muted-foreground/80'
              : 'text-muted-foreground/40 hover:text-muted-foreground/70'
          )}
          aria-pressed={sidebarListMode === 'missions'}
          data-sidebar-section-title="missions"
          onClick={() => setSidebarListMode('missions')}
        >
          {translate('auto.components.sidebar.SidebarHeader.ea1ec23452', 'Missions')}
        </button>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {sidebarListMode === 'projects' ? (
          <>
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
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                className="text-muted-foreground"
                aria-label={translate(
                  'auto.components.sidebar.SidebarHeader.60c23631f0',
                  'New Mission'
                )}
                disabled={!canCreateWorkspace}
                onClick={() => openModal('mission-create')}
              >
                <Plus className="size-3.5" strokeWidth={2.25} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {canCreateWorkspace
                ? translate('auto.components.sidebar.SidebarHeader.60c23631f0', 'New Mission')
                : translate(
                    'auto.components.sidebar.SidebarHeader.52cff41bb2',
                    'Add a project to create a mission'
                  )}
            </TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
})

export default SidebarHeader

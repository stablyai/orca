import React from 'react'
import { FolderPlus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ScrollToCurrentWorkspaceToolbarButton } from './ScrollToCurrentWorkspaceToolbarButton'
import { SidebarSettingsHelpMenu } from './SidebarSettingsHelpMenu'
import { translate } from '@/i18n/i18n'

const SidebarToolbar = React.memo(function SidebarToolbar() {
  const openModal = useAppStore((s) => s.openModal)

  return (
    <div className="mt-auto shrink-0">
      <div className="flex items-center justify-between border-t border-worktree-sidebar-border px-2 py-1.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => openModal('add-repo')}
              className="gap-1.5 text-muted-foreground"
            >
              <FolderPlus className="size-3.5" />
              <span className="text-[11px]">
                {translate('auto.components.sidebar.SidebarToolbar.abc62b6328', 'Add Project')}
              </span>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {translate(
              'auto.components.sidebar.SidebarToolbar.19e32d0e5f',
              'Open folder picker to add a project'
            )}
          </TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1">
          <ScrollToCurrentWorkspaceToolbarButton />
          <SidebarSettingsHelpMenu />
        </div>
      </div>
    </div>
  )
})

export default SidebarToolbar

import React, { useCallback, useEffect, useState } from 'react'
import { Kanban, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'

const isMac = navigator.userAgent.includes('Mac')
const newWorktreeShortcutLabel = isMac ? '⌘N' : 'Ctrl+N'

const SidebarHeader = React.memo(function SidebarHeader() {
  const [workspaceBoardOpen, setWorkspaceBoardOpen] = useState(false)
  const [workspaceBoardMenuOpen, setWorkspaceBoardMenuOpen] = useState(false)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const canCreateWorktree = repos.some((repo) => isGitRepoKind(repo))

  const handleWorkspaceBoardOpenChange = useCallback((open: boolean) => {
    setWorkspaceBoardOpen(open)
    if (!open) {
      setWorkspaceBoardMenuOpen(false)
    }
  }, [])

  const handleWorkspaceBoardToggle = useCallback(() => {
    setWorkspaceBoardOpen((open) => !open)
  }, [])

  useEffect(() => {
    if (!workspaceBoardOpen) {
      return
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') {
        return
      }
      if (workspaceBoardMenuOpen) {
        return
      }
      // Why: Escape must dismiss any nested overlay (Radix dropdown, popover,
      // tooltip, dialog, context menu) ahead of collapsing this non-modal
      // companion panel. Radix portals open popper content into a wrapper
      // element, and dialogs/menus expose `data-state="open"` on their
      // content node, so the presence of either signals the user's intent
      // is to dismiss that overlay rather than the workspace board.
      if (
        document.querySelector(
          '[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="menu"][data-state="open"], [role="listbox"][data-state="open"]'
        )
      ) {
        return
      }
      event.preventDefault()
      setWorkspaceBoardOpen(false)
    }

    // Why: the workspace board is a non-modal companion panel, so focus may
    // be outside the sheet when Escape should still dismiss it.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [workspaceBoardMenuOpen, workspaceBoardOpen])

  return (
    <>
      <div className="mt-2 flex h-8 items-center justify-between px-2 gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="pl-2 pr-0.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80 select-none">
            Workspaces
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <SidebarWorkspaceOptionsMenu
            preserveWorkspaceBoardOpen
            onMenuOpenChange={setWorkspaceBoardMenuOpen}
          />

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={workspaceBoardOpen ? 'secondary' : 'ghost'}
                size="icon-xs"
                className="text-muted-foreground"
                aria-label="Workspace board"
                aria-pressed={workspaceBoardOpen}
                data-workspace-board-trigger=""
                onClick={handleWorkspaceBoardToggle}
              >
                <Kanban className="size-3.5" strokeWidth={2.25} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {workspaceBoardOpen ? 'Close workspace board' : 'Workspace board'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => {
                  if (!canCreateWorktree) {
                    return
                  }
                  openModal('new-workspace-composer', { telemetrySource: 'sidebar' })
                }}
                aria-label="New workspace"
                disabled={!canCreateWorktree}
              >
                <Plus className="size-3.5" strokeWidth={2.25} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={6}>
              {canCreateWorktree
                ? `New workspace (${newWorktreeShortcutLabel})`
                : 'Add a Git project to create worktrees'}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      <WorkspaceKanbanDrawer
        open={workspaceBoardOpen}
        preserveOpenForMenu={workspaceBoardMenuOpen}
        onOpenChange={handleWorkspaceBoardOpenChange}
        onMenuOpenChange={setWorkspaceBoardMenuOpen}
      />
    </>
  )
})

export default SidebarHeader

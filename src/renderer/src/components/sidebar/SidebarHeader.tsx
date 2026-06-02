import React, { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronDown, FolderPlus, GitBranch, Kanban, Monitor, Plus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import SidebarWorkspaceOptionsMenu from './SidebarWorkspaceOptionsMenu'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'
import { useShortcutLabel } from '@/hooks/useShortcutLabel'
import { openWorkspaceCreationComposerWithTourHandoff } from '../contextual-tours/workspace-creation-tour-handoff'

const SidebarHeader = React.memo(function SidebarHeader() {
  const newWorktreeShortcutLabel = useShortcutLabel('workspace.create')
  const [workspaceBoardOpen, setWorkspaceBoardOpen] = useState(false)
  const [workspaceBoardMenuOpen, setWorkspaceBoardMenuOpen] = useState(false)
  const workspaceBoardOpenRef = useRef(workspaceBoardOpen)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const groupBy = useAppStore((s) => s.groupBy)
  const canCreateWorkspace = repos.length > 0
  const isRepoGrouping = groupBy === 'repo'
  const sidebarTitle = isRepoGrouping ? 'Projects' : 'Workspaces'
  workspaceBoardOpenRef.current = workspaceBoardOpen

  const openAddRepo = useCallback(
    (data: Record<string, unknown> = {}) => {
      openModal('add-repo', data)
    },
    [openModal]
  )

  const openWorkspaceBoard = useCallback(() => {
    if (workspaceBoardOpenRef.current) {
      return
    }
    workspaceBoardOpenRef.current = true
    // Why: opening the board is the user action; recording here avoids a
    // post-render bookkeeping Effect in the drawer.
    useAppStore.getState().recordFeatureInteraction('workspace-board')
    setWorkspaceBoardOpen(true)
  }, [])

  const closeWorkspaceBoard = useCallback(() => {
    workspaceBoardOpenRef.current = false
    setWorkspaceBoardOpen(false)
    setWorkspaceBoardMenuOpen(false)
  }, [])

  const handleWorkspaceBoardOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        openWorkspaceBoard()
        return
      }
      closeWorkspaceBoard()
    },
    [closeWorkspaceBoard, openWorkspaceBoard]
  )

  const handleWorkspaceBoardToggle = useCallback(() => {
    if (workspaceBoardOpen) {
      closeWorkspaceBoard()
      return
    }
    openWorkspaceBoard()
  }, [closeWorkspaceBoard, openWorkspaceBoard, workspaceBoardOpen])

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
      closeWorkspaceBoard()
    }

    // Why: the workspace board is a non-modal companion panel, so focus may
    // be outside the sheet when Escape should still dismiss it.
    document.addEventListener('keydown', handleKeyDown, true)
    return () => document.removeEventListener('keydown', handleKeyDown, true)
  }, [closeWorkspaceBoard, workspaceBoardMenuOpen, workspaceBoardOpen])

  return (
    <>
      <div className="mt-2 flex h-8 items-center justify-between px-2 gap-2">
        <div className="flex min-w-0 items-center gap-1">
          <span className="truncate pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80 select-none">
            {sidebarTitle}
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

          <DropdownMenu modal={false} onOpenChange={setWorkspaceBoardMenuOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                // Why: Direction A combines workspace creation and adding a
                // project under the Projects header, so the affordance reads
                // as "Add" near the list rather than another bare plus icon.
                size={isRepoGrouping ? 'xs' : 'icon-xs'}
                aria-label="Add to Orca"
                className={isRepoGrouping ? 'gap-1 text-muted-foreground' : 'text-muted-foreground'}
                data-contextual-tour-target={
                  canCreateWorkspace ? 'workspace-create-control' : undefined
                }
              >
                <Plus className="size-3.5" strokeWidth={2.25} />
                {isRepoGrouping ? <span className="text-[11px]">Add</span> : null}
                {isRepoGrouping ? <ChevronDown className="size-3 opacity-60" /> : null}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-64">
              <DropdownMenuLabel>Worktree</DropdownMenuLabel>
              <DropdownMenuItem
                onSelect={() => {
                  if (!canCreateWorkspace) {
                    return
                  }
                  openWorkspaceCreationComposerWithTourHandoff()
                }}
                aria-label="New workspace"
                disabled={!canCreateWorkspace}
              >
                <Plus className="size-3.5" />
                <span className="flex min-w-0 flex-col">
                  <span>New worktree</span>
                </span>
                {canCreateWorkspace ? (
                  <DropdownMenuShortcut>{newWorktreeShortcutLabel}</DropdownMenuShortcut>
                ) : null}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>Project</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => openAddRepo({ autoBrowse: true })}>
                <FolderPlus className="size-3.5" />
                <span className="flex min-w-0 flex-col">
                  <span>Open local folder...</span>
                  <span className="text-[11px] leading-4 font-normal text-muted-foreground">
                    Pick a Git repo on this machine
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openAddRepo({ initialStep: 'clone' })}>
                <GitBranch className="size-3.5" />
                <span className="flex min-w-0 flex-col">
                  <span>Clone from GitHub / GitLab...</span>
                  <span className="text-[11px] leading-4 font-normal text-muted-foreground">
                    Paste a repository URL
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => openAddRepo({ initialStep: 'remote' })}>
                <Monitor className="size-3.5" />
                <span className="flex min-w-0 flex-col">
                  <span>Remote (SSH) project...</span>
                  <span className="text-[11px] leading-4 font-normal text-muted-foreground">
                    Connect to a repo on a remote host
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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

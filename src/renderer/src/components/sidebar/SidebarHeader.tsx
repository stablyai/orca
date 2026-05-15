import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, SlidersHorizontal } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import type { WorktreeCardProperty } from '../../../../shared/types'
import SidebarFilter from './SidebarFilter'
import WorkspaceKanbanDrawer from './WorkspaceKanbanDrawer'

const GROUP_BY_OPTIONS = [
  { id: 'none', label: 'Status' },
  { id: 'pr-status', label: 'PR' },
  { id: 'repo', label: 'Repo' }
] as const

const PROPERTY_OPTIONS: { id: WorktreeCardProperty; label: string }[] = [
  { id: 'status', label: 'Terminal status' },
  { id: 'unread', label: 'Unread indicator' },
  { id: 'ci', label: 'CI checks' },
  { id: 'issue', label: 'Linked issue' },
  { id: 'pr', label: 'Linked PR' },
  { id: 'comment', label: 'Comment' },
  // Why: toggles the inline "Agent activity" list rendered below each
  // workspace card body (see WorktreeCard → WorktreeCardAgents). Off hides
  // the list; there is no alternate surface.
  { id: 'inline-agents', label: 'Agent activity' }
]

const SORT_OPTIONS = [
  { id: 'name', label: 'Name', description: null },
  {
    id: 'smart',
    label: 'Smart',
    description: 'Agents that need attention, then most recent activity.'
  },
  { id: 'recent', label: 'Recent', description: null },
  { id: 'repo', label: 'Repo', description: null }
] as const

const isMac = navigator.userAgent.includes('Mac')
const newWorktreeShortcutLabel = isMac ? '⌘N' : 'Ctrl+N'
const WORKSPACE_BOARD_HOVER_OPEN_DELAY_MS = 50
// Why: gives the pointer room to travel from the header into the board before
// the temporary hover preview collapses.
const WORKSPACE_BOARD_HOVER_CLOSE_DELAY_MS = 220

const SidebarHeader = React.memo(function SidebarHeader() {
  const [workspaceBoardOpen, setWorkspaceBoardOpen] = useState(false)
  // Why: entering the board turns the hover preview into a persistent drawer
  // until the user explicitly closes it or clicks outside.
  const workspaceBoardPinnedOpenRef = useRef(false)
  const workspaceBoardHoverOpenTimerRef = useRef<number | null>(null)
  const workspaceBoardHoverCloseTimerRef = useRef<number | null>(null)
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const canCreateWorktree = repos.some((repo) => isGitRepoKind(repo))

  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const toggleWorktreeCardProperty = useAppStore((s) => s.toggleWorktreeCardProperty)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)

  const clearWorkspaceBoardHoverClose = useCallback(() => {
    if (workspaceBoardHoverCloseTimerRef.current === null) {
      return
    }
    window.clearTimeout(workspaceBoardHoverCloseTimerRef.current)
    workspaceBoardHoverCloseTimerRef.current = null
  }, [])

  const clearWorkspaceBoardHoverOpen = useCallback(() => {
    if (workspaceBoardHoverOpenTimerRef.current === null) {
      return
    }
    window.clearTimeout(workspaceBoardHoverOpenTimerRef.current)
    workspaceBoardHoverOpenTimerRef.current = null
  }, [])

  useEffect(
    () => () => {
      clearWorkspaceBoardHoverOpen()
      clearWorkspaceBoardHoverClose()
    },
    [clearWorkspaceBoardHoverClose, clearWorkspaceBoardHoverOpen]
  )

  const setWorkspaceBoardPinned = useCallback((pinned: boolean) => {
    workspaceBoardPinnedOpenRef.current = pinned
  }, [])

  const handleWorkspaceBoardOpenChange = useCallback(
    (open: boolean) => {
      clearWorkspaceBoardHoverOpen()
      clearWorkspaceBoardHoverClose()
      setWorkspaceBoardOpen(open)
      if (!open) {
        setWorkspaceBoardPinned(false)
      }
    },
    [clearWorkspaceBoardHoverClose, clearWorkspaceBoardHoverOpen, setWorkspaceBoardPinned]
  )

  const handleWorkspaceHeaderPointerEnter = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') {
        return
      }
      clearWorkspaceBoardHoverClose()
      if (workspaceBoardOpen) {
        return
      }
      clearWorkspaceBoardHoverOpen()
      workspaceBoardHoverOpenTimerRef.current = window.setTimeout(() => {
        workspaceBoardHoverOpenTimerRef.current = null
        setWorkspaceBoardOpen(true)
      }, WORKSPACE_BOARD_HOVER_OPEN_DELAY_MS)
    },
    [clearWorkspaceBoardHoverClose, clearWorkspaceBoardHoverOpen, workspaceBoardOpen]
  )

  const handleWorkspaceHeaderPointerLeave = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      clearWorkspaceBoardHoverOpen()
      if (event.pointerType !== 'mouse' || workspaceBoardPinnedOpenRef.current) {
        return
      }
      clearWorkspaceBoardHoverClose()
      workspaceBoardHoverCloseTimerRef.current = window.setTimeout(() => {
        workspaceBoardHoverCloseTimerRef.current = null
        if (workspaceBoardPinnedOpenRef.current) {
          return
        }
        setWorkspaceBoardOpen(false)
      }, WORKSPACE_BOARD_HOVER_CLOSE_DELAY_MS)
    },
    [clearWorkspaceBoardHoverClose, clearWorkspaceBoardHoverOpen]
  )

  const handleWorkspaceBoardPointerEnter = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.pointerType !== 'mouse') {
        return
      }
      clearWorkspaceBoardHoverOpen()
      clearWorkspaceBoardHoverClose()
      setWorkspaceBoardPinned(true)
      setWorkspaceBoardOpen(true)
    },
    [clearWorkspaceBoardHoverClose, clearWorkspaceBoardHoverOpen, setWorkspaceBoardPinned]
  )

  return (
    <>
      <div
        className="flex h-8 items-center justify-between px-2 gap-2"
        onPointerEnter={handleWorkspaceHeaderPointerEnter}
        onPointerLeave={handleWorkspaceHeaderPointerLeave}
      >
        <div className="flex min-w-0 items-center gap-1">
          <span className="px-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80 select-none">
            Workspaces
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <SidebarFilter />
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    className="text-muted-foreground"
                    aria-label="View options"
                  >
                    <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                View options
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-56 pb-2">
              <DropdownMenuLabel>Group by</DropdownMenuLabel>
              <div className="px-2 pt-0.5 pb-1">
                <ToggleGroup
                  type="single"
                  value={groupBy}
                  onValueChange={(v) => {
                    if (v) {
                      setGroupBy(v as typeof groupBy)
                    }
                  }}
                  variant="outline"
                  size="sm"
                  className="h-6 w-full justify-start"
                >
                  {GROUP_BY_OPTIONS.map((opt) => (
                    <ToggleGroupItem
                      key={opt.id}
                      value={opt.id}
                      className="h-6 px-2 text-[10px] data-[state=on]:bg-foreground/10 data-[state=on]:font-semibold data-[state=on]:text-foreground"
                    >
                      {opt.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Sort by</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortBy}
                onValueChange={(v) => setSortBy(v as typeof sortBy)}
              >
                {SORT_OPTIONS.map((opt) => {
                  const radioItem = (
                    <DropdownMenuRadioItem
                      key={opt.id}
                      value={opt.id}
                      // Keep the menu open so people can compare sort modes and
                      // toggle card properties without reopening the same panel.
                      onSelect={(e) => e.preventDefault()}
                    >
                      {opt.label}
                    </DropdownMenuRadioItem>
                  )
                  if (!opt.description) {
                    return radioItem
                  }
                  return (
                    <Tooltip key={opt.id}>
                      <TooltipTrigger asChild>{radioItem}</TooltipTrigger>
                      <TooltipContent side="right" sideOffset={6}>
                        {opt.description}
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </DropdownMenuRadioGroup>

              <DropdownMenuSeparator />
              <DropdownMenuLabel>Show properties</DropdownMenuLabel>
              {PROPERTY_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.id}
                  checked={worktreeCardProperties.includes(opt.id)}
                  onCheckedChange={() => toggleWorktreeCardProperty(opt.id)}
                  onSelect={(e) => e.preventDefault()}
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

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
        onOpenChange={handleWorkspaceBoardOpenChange}
        onPointerEnter={handleWorkspaceBoardPointerEnter}
      />
    </>
  )
})

export default SidebarHeader

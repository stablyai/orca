import React, { useCallback } from 'react'
import { Activity, FolderPlus, Plus, SlidersHorizontal, X } from 'lucide-react'
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
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu'
import type { WorktreeCardProperty } from '../../../../shared/types'
import RepoDotLabel from '@/components/repo/RepoDotLabel'

const GROUP_BY_OPTIONS = [
  { id: 'none', label: 'All' },
  { id: 'pr-status', label: 'PR Status' },
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
  { id: 'name', label: 'Name' },
  { id: 'smart', label: 'Smart' },
  { id: 'recent', label: 'Recent' },
  { id: 'repo', label: 'Repo' }
] as const

const isMac = navigator.userAgent.includes('Mac')
const newWorktreeShortcutLabel = isMac ? '⌘N' : 'Ctrl+N'

const SidebarHeader = React.memo(function SidebarHeader() {
  const openModal = useAppStore((s) => s.openModal)
  const repos = useAppStore((s) => s.repos)
  const canCreateWorktree = repos.some((repo) => isGitRepoKind(repo))

  const worktreeCardProperties = useAppStore((s) => s.worktreeCardProperties)
  const toggleWorktreeCardProperty = useAppStore((s) => s.toggleWorktreeCardProperty)
  const sortBy = useAppStore((s) => s.sortBy)
  const setSortBy = useAppStore((s) => s.setSortBy)
  const groupBy = useAppStore((s) => s.groupBy)
  const setGroupBy = useAppStore((s) => s.setGroupBy)
  // Why: hide the 'Agents in card' checkbox entirely when the experimental
  // live-agent-activity feature is off — toggling it is a no-op otherwise
  // (WorktreeCard gates rendering on the same flag), so surfacing a dead
  // checkbox is just misleading chrome.
  const liveAgentsEnabled = useAppStore((s) => s.settings?.experimentalAgentDashboard === true)
  const visiblePropertyOptions = liveAgentsEnabled
    ? PROPERTY_OPTIONS
    : PROPERTY_OPTIONS.filter((opt) => opt.id !== 'inline-agents')

  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const addRepo = useAppStore((s) => s.addRepo)

  const canFilterRepos = repos.length > 1
  const hasRepoFilter = canFilterRepos && filterRepoIds.length > 0
  const hasAnyFilter = showActiveOnly || hasRepoFilter

  const handleToggleRepo = useCallback(
    (repoId: string) => {
      setFilterRepoIds(
        filterRepoIds.includes(repoId)
          ? filterRepoIds.filter((id) => id !== repoId)
          : [...filterRepoIds, repoId]
      )
    },
    [filterRepoIds, setFilterRepoIds]
  )

  return (
    <div className="flex h-8 items-center justify-between px-2 mt-1 gap-2">
      <span className="px-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80 select-none">
        Workspaces
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="relative text-muted-foreground"
                  aria-label="View options"
                >
                  <SlidersHorizontal className="size-3.5" strokeWidth={2.25} />
                  {hasAnyFilter && (
                    // Why: signals that filters are applied even though the
                    // control itself is just the view-options gear — without
                    // this dot there's no affordance that the workspace list
                    // is being filtered.
                    <span
                      aria-hidden
                      className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-primary"
                    />
                  )}
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
              {SORT_OPTIONS.map((opt) => (
                <DropdownMenuRadioItem
                  key={opt.id}
                  value={opt.id}
                  // Keep the menu open so people can compare sort modes and
                  // toggle card properties without reopening the same panel.
                  onSelect={(e) => e.preventDefault()}
                >
                  {opt.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>

            <DropdownMenuSeparator />
            <DropdownMenuLabel>Show properties</DropdownMenuLabel>
            {visiblePropertyOptions.map((opt) => (
              <DropdownMenuCheckboxItem
                key={opt.id}
                checked={worktreeCardProperties.includes(opt.id)}
                onCheckedChange={() => toggleWorktreeCardProperty(opt.id)}
                onSelect={(e) => e.preventDefault()}
              >
                {opt.label}
              </DropdownMenuCheckboxItem>
            ))}

            <DropdownMenuSeparator />
            <DropdownMenuLabel>Filter</DropdownMenuLabel>
            <DropdownMenuCheckboxItem
              checked={showActiveOnly}
              onCheckedChange={(v) => setShowActiveOnly(!!v)}
              onSelect={(e) => e.preventDefault()}
            >
              <Activity className="size-3.5 text-muted-foreground" />
              Active only
            </DropdownMenuCheckboxItem>
            {canFilterRepos && (
              <>
                <DropdownMenuLabel className="pt-1 text-[10px] font-normal text-muted-foreground/80">
                  Repositories
                </DropdownMenuLabel>
                {repos.map((r) => (
                  <DropdownMenuCheckboxItem
                    key={r.id}
                    checked={filterRepoIds.includes(r.id)}
                    onCheckedChange={() => handleToggleRepo(r.id)}
                    onSelect={(e) => e.preventDefault()}
                  >
                    <RepoDotLabel name={r.displayName} color={r.badgeColor} />
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}
            {hasAnyFilter && (
              <DropdownMenuItem
                onSelect={() => {
                  setShowActiveOnly(false)
                  setFilterRepoIds([])
                }}
              >
                <X className="size-3.5 text-muted-foreground" />
                Clear filters
              </DropdownMenuItem>
            )}
            {canFilterRepos && (
              <DropdownMenuItem
                inset
                onSelect={() => {
                  addRepo()
                }}
              >
                <FolderPlus className="absolute left-2.5 size-3.5 text-muted-foreground" />
                Add project
              </DropdownMenuItem>
            )}
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
                openModal('new-workspace-composer')
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
  )
})

export default SidebarHeader

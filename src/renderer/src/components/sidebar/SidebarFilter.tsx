import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, FolderPlus, GitBranch, ListFilter, Moon, Server } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { searchRepos } from '@/lib/repo-search'
import { cn } from '@/lib/utils'

type SidebarFilterProps = {
  preserveWorkspaceBoardOpen?: boolean
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left'
  contentSide?: 'top' | 'right' | 'bottom' | 'left'
  onMenuOpenChange?: (open: boolean) => void
}

const SidebarFilter = React.memo(function SidebarFilter({
  preserveWorkspaceBoardOpen = false,
  tooltipSide = 'bottom',
  contentSide = 'right',
  onMenuOpenChange
}: SidebarFilterProps) {
  const showSleepingWorkspaces = useAppStore((s) => s.showSleepingWorkspaces)
  const setShowSleepingWorkspaces = useAppStore((s) => s.setShowSleepingWorkspaces)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      onMenuOpenChange?.(next)
      if (!next) {
        setQuery('')
      }
    },
    [onMenuOpenChange]
  )

  useEffect(() => {
    return () => {
      onMenuOpenChange?.(false)
    }
  }, [onMenuOpenChange])

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

  const canFilterRepos = repos.length > 1
  // Why: derive from current repos so stale ids (e.g. lingering after a repo
  // is removed) don't inflate counts or falsely signal an applied filter.
  const selectedRepoIdSet = useMemo(() => {
    const set = new Set<string>()
    for (const r of repos) {
      if (filterRepoIds.includes(r.id)) {
        set.add(r.id)
      }
    }
    return set
  }, [repos, filterRepoIds])
  const selectedCount = selectedRepoIdSet.size
  const hasRepoFilter = selectedCount > 0
  const hasAnyFilter = showSleepingWorkspaces || hideDefaultBranchWorkspace || hasRepoFilter
  const activeFilterCount =
    (showSleepingWorkspaces ? 1 : 0) + (hideDefaultBranchWorkspace ? 1 : 0) + selectedCount

  const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query])

  // Why: with shouldFilter={false} cmdk won't auto-highlight a row, so Enter
  // has no target. Keep the highlighted value pinned to the first filtered
  // repo whenever the query changes.
  useEffect(() => {
    const first = filteredRepos[0]
    if (first && !filteredRepos.some((r) => r.id === commandValue)) {
      setCommandValue(first.id)
    }
  }, [filteredRepos, commandValue])
  const allSelected = canFilterRepos && selectedCount === repos.length

  const clearAll = useCallback(() => {
    setShowSleepingWorkspaces(false)
    setHideDefaultBranchWorkspace(false)
    setFilterRepoIds([])
  }, [setShowSleepingWorkspaces, setHideDefaultBranchWorkspace, setFilterRepoIds])

  // Why: derive ids from the live repos list at click time so a repo added
  // while the popover is open is included immediately.
  const selectAllRepos = useCallback(() => {
    setFilterRepoIds(repos.map((r) => r.id))
  }, [repos, setFilterRepoIds])

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={
                hasAnyFilter ? `Edit filters (${activeFilterCount} active)` : 'Filter workspaces'
              }
              className="relative text-muted-foreground"
              data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
            >
              <ListFilter className="size-3.5" strokeWidth={2.25} />
              {hasAnyFilter && (
                // Why: the only at-a-glance affordance that filters are
                // applied — without it the list can silently hide workspaces.
                <span
                  aria-hidden
                  className="absolute -top-0.5 -right-0.5 flex h-3 min-w-3 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-medium leading-none text-primary-foreground"
                >
                  {activeFilterCount > 9 ? '9+' : activeFilterCount}
                </span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide} sideOffset={6}>
          {hasAnyFilter ? 'Edit filters' : 'Filter workspaces'}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        side={contentSide}
        align="start"
        sideOffset={8}
        className="w-72"
        data-workspace-board-preserve-open={preserveWorkspaceBoardOpen ? '' : undefined}
      >
        <FilterToggleRow
          icon={<Moon className="size-3.5" />}
          label="Show sleeping"
          checked={showSleepingWorkspaces}
          onChange={setShowSleepingWorkspaces}
        />
        <FilterToggleRow
          icon={<GitBranch className="size-3.5" />}
          label="Hide default branch"
          checked={hideDefaultBranchWorkspace}
          onChange={setHideDefaultBranchWorkspace}
        />

        {canFilterRepos && (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-semibold tracking-wide uppercase text-muted-foreground">
                Repositories
                {hasRepoFilter && (
                  <span className="ml-1.5 normal-case tracking-normal font-medium text-foreground">
                    · {selectedCount}
                  </span>
                )}
              </span>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={selectAllRepos}
                  className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
                  disabled={allSelected}
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={clearRepos}
                  className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
                  disabled={!hasRepoFilter}
                >
                  Clear
                </button>
              </div>
            </div>

            <Command
              shouldFilter={false}
              value={commandValue}
              onValueChange={setCommandValue}
              className="bg-transparent"
            >
              <CommandInput
                autoFocus
                placeholder="Search repos..."
                value={query}
                onValueChange={setQuery}
                onKeyDown={(event) => event.stopPropagation()}
                className="h-8 py-2 text-xs"
                wrapperClassName="mx-1 rounded-[7px] border border-border/70 px-2"
                iconClassName="h-3.5 w-3.5"
              />
              <CommandList className="max-h-64 py-1">
                <CommandEmpty className="py-4 text-[11px]">No repos match</CommandEmpty>
                {filteredRepos.map((r) => {
                  const checked = selectedRepoIdSet.has(r.id)
                  return (
                    <CommandItem
                      key={r.id}
                      value={r.id}
                      onSelect={() => handleToggleRepo(r.id)}
                      className="mx-1 my-0.5 items-center gap-2 rounded-[7px] px-2 py-1 text-[12px] leading-5 font-medium data-[selected=true]:bg-black/8 dark:data-[selected=true]:bg-white/14"
                    >
                      <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                        <RepoDotLabel
                          name={r.displayName}
                          color={r.badgeColor}
                          className="max-w-full"
                        />
                        {r.connectionId && (
                          <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                            <Server className="size-2.5" />
                            SSH
                          </span>
                        )}
                      </span>
                      {checked && (
                        <Check className="size-3 shrink-0 text-primary" strokeWidth={3} />
                      )}
                    </CommandItem>
                  )
                })}
              </CommandList>
            </Command>
          </>
        )}

        <DropdownMenuSeparator />
        {/* Why: "Add repo" stays visible regardless of repo count so users
            can recover from the 0/1-repo state where the repo section is
            hidden. Reset sits beside it only when a filter is active. */}
        <div className="flex items-center justify-between gap-1 px-1 py-1">
          {hasAnyFilter ? (
            <button
              type="button"
              onClick={clearAll}
              className="rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              Reset filters
            </button>
          ) : (
            <span />
          )}
          <button
            type="button"
            onClick={() => addRepo()}
            className="inline-flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <FolderPlus className="size-3.5" />
            Add repo
          </button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

function FilterToggleRow({
  icon,
  label,
  checked,
  onChange
}: {
  icon: React.ReactNode
  label: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-center justify-between gap-2 rounded-[5px] px-2 py-1.5 text-[12px] font-medium hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="inline-flex items-center gap-2 text-foreground">
        <span className="text-muted-foreground">{icon}</span>
        {label}
      </span>
      <span
        aria-hidden
        className={cn(
          'relative h-3.5 w-6 shrink-0 rounded-full transition-colors',
          checked ? 'bg-primary' : 'bg-muted-foreground/30'
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 size-2.5 rounded-full bg-background shadow-sm transition-transform',
            checked && 'translate-x-2.5'
          )}
        />
      </span>
    </button>
  )
}

export default SidebarFilter

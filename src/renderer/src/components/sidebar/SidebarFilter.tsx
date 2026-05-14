import React, { useCallback, useMemo, useState } from 'react'
import { Activity, Check, GitBranch, ListFilter, FolderPlus, Server, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { searchRepos } from '@/lib/repo-search'
import { cn } from '@/lib/utils'

const SidebarFilter = React.memo(function SidebarFilter() {
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const hideDefaultBranchWorkspace = useAppStore((s) => s.hideDefaultBranchWorkspace)
  const setHideDefaultBranchWorkspace = useAppStore((s) => s.setHideDefaultBranchWorkspace)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)

  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (!next) {
      setQuery('')
    }
  }, [])

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
  const hasAnyFilter = showActiveOnly || hideDefaultBranchWorkspace || hasRepoFilter
  const activeFilterCount =
    (showActiveOnly ? 1 : 0) + (hideDefaultBranchWorkspace ? 1 : 0) + selectedCount

  const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query])
  const allSelected = canFilterRepos && selectedCount === repos.length

  const clearAll = useCallback(() => {
    setShowActiveOnly(false)
    setHideDefaultBranchWorkspace(false)
    setFilterRepoIds([])
  }, [setShowActiveOnly, setHideDefaultBranchWorkspace, setFilterRepoIds])

  // Why: derive ids from the live repos list at click time so a repo added
  // while the popover is open is included immediately.
  const selectAllRepos = useCallback(() => {
    setFilterRepoIds(repos.map((r) => r.id))
  }, [repos, setFilterRepoIds])

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])
  const closeFilters = useCallback(() => handleOpenChange(false), [handleOpenChange])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              aria-label={
                hasAnyFilter ? `Edit filters (${activeFilterCount} active)` : 'Filter workspaces'
              }
              className="relative text-muted-foreground"
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
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {hasAnyFilter ? 'Edit filters' : 'Filter workspaces'}
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between gap-2 px-3 py-2">
          <span className="text-xs font-medium text-foreground">Filters</span>
          <div className="flex items-center gap-1">
            {hasAnyFilter ? (
              <button
                type="button"
                onClick={clearAll}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <X className="size-3" />
                Clear all
              </button>
            ) : null}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Close filters"
                  className="text-muted-foreground"
                  onClick={closeFilters}
                >
                  <X className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                Close filters
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="border-t border-border/60">
          <ToggleRow
            icon={<Activity className="size-3.5" />}
            label="Active only"
            checked={showActiveOnly}
            onClick={() => setShowActiveOnly(!showActiveOnly)}
          />
          <ToggleRow
            icon={<GitBranch className="size-3.5" />}
            label="Hide default branch"
            checked={hideDefaultBranchWorkspace}
            onClick={() => setHideDefaultBranchWorkspace(!hideDefaultBranchWorkspace)}
          />
        </div>

        {canFilterRepos && (
          <div className="border-t border-border/60">
            <div className="flex items-center justify-between px-3 pt-2 pb-1">
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                Repositories
                {hasRepoFilter && (
                  <span className="ml-1.5 text-foreground normal-case tracking-normal">
                    {selectedCount} selected
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <button
                  type="button"
                  onClick={selectAllRepos}
                  className="hover:text-foreground disabled:opacity-40"
                  disabled={allSelected}
                >
                  All
                </button>
                <span className="text-border">·</span>
                <button
                  type="button"
                  onClick={clearRepos}
                  className="hover:text-foreground disabled:opacity-40"
                  disabled={!hasRepoFilter}
                >
                  None
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
                className="h-8 py-2 text-xs"
                wrapperClassName="px-3"
                iconClassName="h-3.5 w-3.5"
              />
              <CommandList className="max-h-64">
                <CommandEmpty className="py-4 text-[11px]">No repos match</CommandEmpty>
                {filteredRepos.map((r) => {
                  const checked = selectedRepoIdSet.has(r.id)
                  return (
                    <CommandItem
                      key={r.id}
                      value={r.id}
                      onSelect={() => handleToggleRepo(r.id)}
                      className="items-center gap-2 px-3 py-1.5 text-xs"
                    >
                      <Check
                        className={cn(
                          'size-3 shrink-0 text-muted-foreground',
                          checked ? 'opacity-100' : 'opacity-0'
                        )}
                      />
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
                    </CommandItem>
                  )
                })}
              </CommandList>
            </Command>
          </div>
        )}

        {/* Why: per design, "Add project" stays visible regardless of repo
            count so users can recover from the 0/1-repo state where the
            repo section is hidden. */}
        <div className="border-t border-border/60">
          <button
            type="button"
            onClick={() => addRepo()}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
          >
            <FolderPlus className="size-3.5" />
            Add project
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
})

type ToggleRowProps = {
  icon: React.ReactNode
  label: string
  checked: boolean
  onClick: () => void
}

function ToggleRow({ icon, label, checked, onClick }: ToggleRowProps) {
  // Why: the popover is not a true menu, so we use a plain button with
  // aria-pressed rather than role="menuitemcheckbox". The visible checkmark
  // carries the state for sighted users.
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={checked}
      className={cn(
        'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-accent hover:text-accent-foreground',
        checked ? 'text-foreground' : 'text-muted-foreground'
      )}
    >
      <Check
        className={cn(
          'size-3 shrink-0 text-muted-foreground',
          checked ? 'opacity-100' : 'opacity-0'
        )}
      />
      <span className="text-muted-foreground">{icon}</span>
      <span className={cn(checked && 'text-foreground')}>{label}</span>
    </button>
  )
}

export default SidebarFilter

import React, { useCallback, useMemo, useState } from 'react'
import { Activity, Check, FolderPlus, GitBranch, ListFilter, Server } from 'lucide-react'
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
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
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

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
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
        <TooltipContent side="bottom" sideOffset={6}>
          {hasAnyFilter ? 'Edit filters' : 'Filter workspaces'}
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="right" align="start" sideOffset={8} className="w-72">
        <DropdownMenuCheckboxItem
          checked={showActiveOnly}
          onCheckedChange={(checked) => setShowActiveOnly(Boolean(checked))}
          onSelect={(event) => event.preventDefault()}
        >
          <Activity className="size-3.5" />
          Active only
        </DropdownMenuCheckboxItem>
        <DropdownMenuCheckboxItem
          checked={hideDefaultBranchWorkspace}
          onCheckedChange={(checked) => setHideDefaultBranchWorkspace(Boolean(checked))}
          onSelect={(event) => event.preventDefault()}
        >
          <GitBranch className="size-3.5" />
          Hide default branch
        </DropdownMenuCheckboxItem>

        {canFilterRepos && (
          <>
            <DropdownMenuSeparator />
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11px] font-semibold text-muted-foreground">
                Repositories
                {hasRepoFilter && (
                  <span className="ml-1.5 font-medium text-foreground">
                    {selectedCount} selected
                  </span>
                )}
              </span>
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <button
                  type="button"
                  onClick={selectAllRepos}
                  className="rounded-[5px] px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
                  disabled={allSelected}
                >
                  All
                </button>
                <span className="text-border">·</span>
                <button
                  type="button"
                  onClick={clearRepos}
                  className="rounded-[5px] px-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
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
                      className="mx-1 items-center gap-2 rounded-[7px] px-2 py-1 text-[12px] leading-5 font-medium data-[selected=true]:bg-black/8 dark:data-[selected=true]:bg-white/14"
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
          </>
        )}

        {hasAnyFilter && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={(event) => {
                event.preventDefault()
                clearAll()
              }}
              className="text-muted-foreground"
            >
              Reset filters
            </DropdownMenuItem>
          </>
        )}

        {/* Why: per design, "Add project" stays visible regardless of repo
            count so users can recover from the 0/1-repo state where the
            repo section is hidden. */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => addRepo()} className="text-muted-foreground">
          <FolderPlus className="size-3.5" />
          Add project
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export default SidebarFilter

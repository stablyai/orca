import React, { useCallback } from 'react'
import { Activity, ListFilter, FolderPlus, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip'
import RepoDotLabel from '@/components/repo/RepoDotLabel'

const SidebarFilter = React.memo(function SidebarFilter() {
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)

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

  const handleToggleActive = useCallback(
    () => setShowActiveOnly(!showActiveOnly),
    [showActiveOnly, setShowActiveOnly]
  )
  const canFilterRepos = repos.length > 1
  // Why: derive from the current repos list so stale IDs in filterRepoIds
  // (e.g. lingering after a repo is removed) don't inflate the active-filter
  // count or falsely signal an applied filter.
  const selectedRepos = canFilterRepos ? repos.filter((r) => filterRepoIds.includes(r.id)) : []
  const hasRepoFilter = selectedRepos.length > 0
  const hasAnyFilter = showActiveOnly || hasRepoFilter
  const activeFilterCount = (showActiveOnly ? 1 : 0) + selectedRepos.length

  return (
    <DropdownMenu>
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
      <DropdownMenuContent align="end" className="min-w-[12rem]">
        <DropdownMenuLabel>Status</DropdownMenuLabel>
        <DropdownMenuCheckboxItem
          checked={showActiveOnly}
          onCheckedChange={handleToggleActive}
          onSelect={(event) => event.preventDefault()}
        >
          <Activity className="size-3.5 text-muted-foreground" />
          Active only
        </DropdownMenuCheckboxItem>
        {canFilterRepos && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Repositories</DropdownMenuLabel>
            {repos.map((r) => (
              <DropdownMenuCheckboxItem
                key={r.id}
                checked={filterRepoIds.includes(r.id)}
                onCheckedChange={() => handleToggleRepo(r.id)}
                onSelect={(event) => event.preventDefault()}
              >
                <RepoDotLabel name={r.displayName} color={r.badgeColor} />
              </DropdownMenuCheckboxItem>
            ))}
          </>
        )}
        {hasAnyFilter && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => {
                setShowActiveOnly(false)
                setFilterRepoIds([])
              }}
            >
              <X className="size-3.5 text-muted-foreground" />
              Clear filters
            </DropdownMenuItem>
          </>
        )}
        {canFilterRepos && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              inset
              onSelect={() => {
                addRepo()
              }}
            >
              <FolderPlus className="absolute left-2.5 size-3.5 text-muted-foreground" />
              Add project
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

export default SidebarFilter

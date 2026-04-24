import React, { useCallback } from 'react'
import { Search, X, Activity, ListFilter, FolderPlus } from 'lucide-react'
import { useAppStore } from '@/store'
import { Input } from '@/components/ui/input'
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
import { cn } from '@/lib/utils'
import RepoDotLabel from '@/components/repo/RepoDotLabel'

const SearchBar = React.memo(function SearchBar() {
  const searchQuery = useAppStore((s) => s.searchQuery)
  const setSearchQuery = useAppStore((s) => s.setSearchQuery)
  const showActiveOnly = useAppStore((s) => s.showActiveOnly)
  const setShowActiveOnly = useAppStore((s) => s.setShowActiveOnly)
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)
  const selectedRepos = repos.filter((r) => filterRepoIds.includes(r.id))

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

  const handleClear = useCallback(() => setSearchQuery(''), [setSearchQuery])
  const handleToggleActive = useCallback(
    () => setShowActiveOnly(!showActiveOnly),
    [showActiveOnly, setShowActiveOnly]
  )
  const canFilterRepos = repos.length > 1
  const hasRepoFilter = canFilterRepos && selectedRepos.length > 0
  const hasAnyFilter = showActiveOnly || hasRepoFilter
  const activeFilterCount = (showActiveOnly ? 1 : 0) + (hasRepoFilter ? selectedRepos.length : 0)

  const filterSummary = (() => {
    if (!hasAnyFilter) {
      return null
    }
    if (showActiveOnly && !hasRepoFilter) {
      return (
        <span className="flex items-center gap-1">
          <Activity className="size-3" />
          <span>Active</span>
        </span>
      )
    }
    if (!showActiveOnly && hasRepoFilter && selectedRepos.length === 1) {
      return (
        <RepoDotLabel
          name={selectedRepos[0].displayName}
          color={selectedRepos[0].badgeColor}
          dotClassName="size-1"
        />
      )
    }
    return <span>{activeFilterCount} filters</span>
  })()

  return (
    <div className="px-2 pb-4">
      <div className="relative flex items-center">
        <Search className="absolute left-2 size-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search..."
          className="h-7 pl-7 pr-20 text-[11px] border-none bg-muted/50 shadow-none focus-visible:ring-1 focus-visible:ring-ring/30"
        />
        <div className="absolute right-1 flex items-center gap-0.5">
          {searchQuery && (
            <Button variant="ghost" size="icon-xs" onClick={handleClear} className="size-5">
              <X className="size-3" />
            </Button>
          )}
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    aria-label="Filter worktrees"
                    className={cn(
                      'h-5 gap-1 border-none px-1 text-[10px] font-normal shadow-none focus-visible:ring-0',
                      hasAnyFilter
                        ? 'w-auto bg-accent text-accent-foreground hover:bg-accent/80'
                        : 'size-5 w-5 bg-transparent hover:bg-accent/60'
                    )}
                  >
                    <ListFilter className="size-3 shrink-0" />
                    {filterSummary}
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                {hasAnyFilter ? 'Edit filters' : 'Filter worktrees'}
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
        </div>
      </div>
    </div>
  )
})

export default SearchBar

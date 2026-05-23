import React, { useCallback, useMemo, useState } from 'react'
import { Server, X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { searchRepos } from '@/lib/repo-search'
import type { Repo } from '../../../../shared/types'

function projectCommandFilter(_value: string, search: string, keywords?: string[]): number {
  const query = search.trim().toLowerCase()
  if (!query) {
    return 1
  }

  const [displayName = '', path = ''] = keywords ?? []
  const displayNameIndex = displayName.toLowerCase().indexOf(query)
  if (displayNameIndex !== -1) {
    return 2 + 1 / (displayNameIndex + 1)
  }

  const pathIndex = path.toLowerCase().indexOf(query)
  if (pathIndex !== -1) {
    return 1 + 1 / (pathIndex + 1)
  }

  return 0
}

const SidebarRepositoryFilterSection = React.memo(function SidebarRepositoryFilterSection() {
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)

  const [query, setQuery] = useState('')
  const [highlightedRepoId, setHighlightedRepoId] = useState('')

  const canFilterRepos = repos.length > 1
  // Why: derive from current repos so stale ids (e.g. lingering after a repo
  // is removed) don't inflate counts or falsely signal an applied filter.
  const selectedRepoIdSet = useMemo(() => {
    const set = new Set<string>()
    for (const repo of repos) {
      if (filterRepoIds.includes(repo.id)) {
        set.add(repo.id)
      }
    }
    return set
  }, [repos, filterRepoIds])
  const selectedCount = selectedRepoIdSet.size
  const hasRepoFilter = selectedCount > 0
  const selectedRepos = useMemo(
    () => repos.filter((repo) => selectedRepoIdSet.has(repo.id)),
    [repos, selectedRepoIdSet]
  )
  const availableRepos = useMemo(
    () => repos.filter((repo) => !selectedRepoIdSet.has(repo.id)),
    [repos, selectedRepoIdSet]
  )
  const matchingAvailableRepos = useMemo(
    () => searchRepos(availableRepos, query),
    [availableRepos, query]
  )

  const handleSelectRepo = useCallback(
    (repoId: string) => {
      if (!filterRepoIds.includes(repoId)) {
        setFilterRepoIds([...filterRepoIds, repoId])
      }
      setQuery('')
    },
    [filterRepoIds, setFilterRepoIds]
  )

  const handleRemoveRepo = useCallback(
    (repoId: string) => {
      setFilterRepoIds(filterRepoIds.filter((id) => id !== repoId))
    },
    [filterRepoIds, setFilterRepoIds]
  )

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Why: this command is embedded in a Radix dropdown; text keys should
      // stay in the search field instead of triggering menu typeahead.
      if (event.key === 'Backspace' && query === '' && selectedRepos.length > 0) {
        const lastRepo = selectedRepos.at(-1)
        if (lastRepo) {
          event.preventDefault()
          event.stopPropagation()
          handleRemoveRepo(lastRepo.id)
        }
        return
      }

      if (event.key === 'Enter') {
        const highlightedRepo = availableRepos.find((repo) => repo.id === highlightedRepoId)
        const repo = highlightedRepo ?? matchingAvailableRepos[0]
        if (repo) {
          event.preventDefault()
          event.stopPropagation()
          handleSelectRepo(repo.id)
        }
        return
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        event.stopPropagation()
      }
    },
    [
      availableRepos,
      handleRemoveRepo,
      handleSelectRepo,
      highlightedRepoId,
      matchingAvailableRepos,
      query,
      selectedRepos
    ]
  )

  if (!canFilterRepos) {
    return null
  }

  return (
    <>
      <ProjectFilterHeader
        hasRepoFilter={hasRepoFilter}
        selectedCount={selectedCount}
        onClear={clearRepos}
      />

      <Command
        filter={projectCommandFilter}
        onValueChange={setHighlightedRepoId}
        className="bg-transparent"
      >
        <SelectedProjectPills selectedRepos={selectedRepos} onRemoveRepo={handleRemoveRepo} />
        <CommandInput
          autoFocus
          placeholder={selectedRepos.length > 0 ? 'Add project...' : 'Filter projects...'}
          value={query}
          onValueChange={setQuery}
          onKeyDown={handleInputKeyDown}
          className="h-8 py-2 text-xs"
          wrapperClassName="mx-1 rounded-[7px] border border-border/70 px-2"
          iconClassName="h-3.5 w-3.5"
        />
        <CommandList className="max-h-40 py-1">
          <CommandEmpty className="py-4 text-[11px]">
            {hasRepoFilter ? 'No unselected projects match' : 'No projects match'}
          </CommandEmpty>
          {availableRepos.map((repo) => (
            <CommandItem
              key={repo.id}
              value={repo.id}
              keywords={[repo.displayName, repo.path]}
              onSelect={() => handleSelectRepo(repo.id)}
              className="mx-1 my-0.5 items-center gap-2 rounded-[7px] px-2 py-1 text-[12px] leading-5 font-medium data-[selected=true]:bg-black/8 dark:data-[selected=true]:bg-white/14"
            >
              <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                <RepoDotLabel
                  name={repo.displayName}
                  color={repo.badgeColor}
                  className="max-w-full"
                />
                {repo.connectionId && (
                  <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                    <Server className="size-2.5" />
                    SSH
                  </span>
                )}
              </span>
            </CommandItem>
          ))}
        </CommandList>
      </Command>
    </>
  )
})

function SelectedProjectPills({
  selectedRepos,
  onRemoveRepo
}: {
  selectedRepos: Repo[]
  onRemoveRepo: (repoId: string) => void
}) {
  if (selectedRepos.length === 0) {
    return null
  }

  return (
    <div className="scrollbar-sleek mx-1 mb-1 flex max-h-16 flex-wrap gap-1 overflow-y-auto rounded-[7px] border border-border/70 bg-muted/25 p-1">
      {selectedRepos.map((repo) => (
        <Badge
          key={repo.id}
          variant="outline"
          className="h-5 max-w-full gap-1 border-border/70 bg-background px-1.5 py-0 text-[11px] font-medium"
        >
          <RepoDotLabel
            name={repo.displayName}
            color={repo.badgeColor}
            className="max-w-[8rem]"
            dotClassName="size-1.5"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${repo.displayName} filter`}
            className="-mr-1 size-4 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRemoveRepo(repo.id)}
          >
            <X className="size-2.5" strokeWidth={2.5} />
          </Button>
        </Badge>
      ))}
    </div>
  )
}

function ProjectFilterHeader({
  hasRepoFilter,
  selectedCount,
  onClear
}: {
  hasRepoFilter: boolean
  selectedCount: number
  onClear: () => void
}) {
  return (
    <div className="flex items-center justify-between px-2 py-1">
      <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
        Projects
        {hasRepoFilter && (
          <Badge
            variant="outline"
            className="h-4 min-w-4 px-1 py-0 text-[10px] font-semibold leading-none text-foreground"
          >
            {selectedCount}
          </Badge>
        )}
      </span>
      <button
        type="button"
        onClick={onClear}
        className="rounded-full px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40 disabled:hover:bg-transparent"
        disabled={!hasRepoFilter}
      >
        Clear
      </button>
    </div>
  )
}

export default SidebarRepositoryFilterSection

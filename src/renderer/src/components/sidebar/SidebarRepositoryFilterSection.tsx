import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Search, Server, X } from 'lucide-react'
import { Command as CommandPrimitive } from 'cmdk'
import { useAppStore } from '@/store'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { searchRepos } from '@/lib/repo-search'
import type { Repo } from '../../../../shared/types'

const SidebarRepositoryFilterSection = React.memo(function SidebarRepositoryFilterSection() {
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)

  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')

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
  const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query])
  const suggestedRepos = useMemo(
    () => filteredRepos.filter((repo) => !selectedRepoIdSet.has(repo.id)),
    [filteredRepos, selectedRepoIdSet]
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

  // Why: with shouldFilter={false} cmdk won't auto-highlight a row, so Enter
  // has no target. Keep the highlighted value pinned to the first filtered
  // repo whenever the query changes.
  useEffect(() => {
    const first = suggestedRepos[0]
    if (first && !suggestedRepos.some((repo) => repo.id === commandValue)) {
      setCommandValue(first.id)
    }
  }, [suggestedRepos, commandValue])

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])

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
        shouldFilter={false}
        value={commandValue}
        onValueChange={setCommandValue}
        className="bg-transparent"
      >
        <ProjectTokenInput
          selectedRepos={selectedRepos}
          value={query}
          onValueChange={setQuery}
          onRemoveRepo={handleRemoveRepo}
        />
        <CommandList className="max-h-40 py-1">
          <CommandEmpty className="py-4 text-[11px]">
            {hasRepoFilter ? 'All matching projects selected' : 'No projects match'}
          </CommandEmpty>
          {suggestedRepos.map((repo) => (
            <CommandItem
              key={repo.id}
              value={repo.id}
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

function ProjectTokenInput({
  selectedRepos,
  value,
  onValueChange,
  onRemoveRepo
}: {
  selectedRepos: Repo[]
  value: string
  onValueChange: (value: string) => void
  onRemoveRepo: (repoId: string) => void
}) {
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      event.stopPropagation()
      if (event.key === 'Backspace' && value === '' && selectedRepos.length > 0) {
        const lastRepo = selectedRepos.at(-1)
        if (lastRepo) {
          onRemoveRepo(lastRepo.id)
        }
      }
    },
    [onRemoveRepo, selectedRepos, value]
  )

  return (
    <div
      className="mx-1 flex min-h-8 items-center gap-1 rounded-[7px] border border-border/70 px-2 py-1"
      data-cmdk-input-wrapper=""
    >
      <Search className="size-3.5 shrink-0 opacity-50" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
        {selectedRepos.map((repo) => (
          <span
            key={repo.id}
            className="inline-flex max-w-full items-center gap-1 rounded-full border border-border/70 bg-muted/45 px-1.5 py-0.5 text-[11px] font-medium text-foreground"
          >
            <RepoDotLabel
              name={repo.displayName}
              color={repo.badgeColor}
              className="max-w-[7.5rem]"
              dotClassName="size-1.5"
            />
            <button
              type="button"
              aria-label={`Remove ${repo.displayName} filter`}
              className="-mr-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onRemoveRepo(repo.id)}
            >
              <X className="size-2.5" strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <CommandPrimitive.Input
          data-slot="command-input"
          value={value}
          onValueChange={onValueChange}
          onKeyDown={handleKeyDown}
          placeholder={selectedRepos.length > 0 ? 'Add project...' : 'Filter projects...'}
          className="min-w-20 flex-1 bg-transparent py-0.5 text-xs outline-none placeholder:text-muted-foreground"
        />
      </div>
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
          <span className="ml-0.5 normal-case tracking-normal font-medium text-foreground">
            · {selectedCount}
          </span>
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

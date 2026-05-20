import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, FolderPlus, Server } from 'lucide-react'
import { useAppStore } from '@/store'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import RepoDotLabel from '@/components/repo/RepoDotLabel'
import { searchRepos } from '@/lib/repo-search'

const SidebarRepositoryFilterSection = React.memo(function SidebarRepositoryFilterSection() {
  const filterRepoIds = useAppStore((s) => s.filterRepoIds)
  const setFilterRepoIds = useAppStore((s) => s.setFilterRepoIds)
  const repos = useAppStore((s) => s.repos)
  const addRepo = useAppStore((s) => s.addRepo)

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
  const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query])

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

  // Why: with shouldFilter={false} cmdk won't auto-highlight a row, so Enter
  // has no target. Keep the highlighted value pinned to the first filtered
  // repo whenever the query changes.
  useEffect(() => {
    const first = filteredRepos[0]
    if (first && !filteredRepos.some((repo) => repo.id === commandValue)) {
      setCommandValue(first.id)
    }
  }, [filteredRepos, commandValue])

  // Why: derive ids from the live repos list at click time so a repo added
  // while the menu is open is included immediately.
  const selectAllRepos = useCallback(() => {
    setFilterRepoIds(repos.map((repo) => repo.id))
  }, [repos, setFilterRepoIds])

  const clearRepos = useCallback(() => setFilterRepoIds([]), [setFilterRepoIds])
  const allSelected = canFilterRepos && selectedCount === repos.length

  if (!canFilterRepos) {
    return (
      <button
        type="button"
        onClick={() => addRepo()}
        className="inline-flex w-full items-center gap-1.5 rounded-[7px] px-2 py-0.5 text-[12px] leading-5 font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <FolderPlus className="size-3.5" />
        Add repo
      </button>
    )
  }

  return (
    <>
      <div className="flex items-center justify-between px-2 py-1">
        <span className="text-[11px] font-semibold text-muted-foreground">
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
            All
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
          placeholder="Search repos..."
          value={query}
          onValueChange={setQuery}
          onKeyDown={(event) => event.stopPropagation()}
          className="h-8 py-2 text-xs"
          wrapperClassName="mx-1 rounded-[7px] border border-border/70 px-2"
          iconClassName="h-3.5 w-3.5"
        />
        <CommandList className="max-h-40 py-1">
          <CommandEmpty className="py-4 text-[11px]">No repos match</CommandEmpty>
          {filteredRepos.map((repo) => {
            const checked = selectedRepoIdSet.has(repo.id)
            return (
              <CommandItem
                key={repo.id}
                value={repo.id}
                onSelect={() => handleToggleRepo(repo.id)}
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
                {checked && <Check className="size-3 shrink-0 text-primary" strokeWidth={3} />}
              </CommandItem>
            )
          })}
        </CommandList>
      </Command>

      <button
        type="button"
        onClick={() => addRepo()}
        className="inline-flex w-full items-center gap-1.5 rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <FolderPlus className="size-3.5" />
        Add repo
      </button>
    </>
  )
})

export default SidebarRepositoryFilterSection

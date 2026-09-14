import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Server, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { searchRepos } from '@/lib/repo-search'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'

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

type SidebarProjectFilterPanelProps = {
  availableRepos: Repo[]
  selectedRepos: Repo[]
  hasRepoFilter: boolean
  filterRepoIds: readonly string[]
  setFilterRepoIds: (ids: string[]) => void
}

/**
 * Search + selection body of the Projects filter. Lives in its own component so
 * it mounts and unmounts with the submenu panel, which resets the query instead
 * of reopening onto a stale, pre-filtered list.
 */
export function SidebarProjectFilterPanel({
  availableRepos,
  selectedRepos,
  hasRepoFilter,
  filterRepoIds,
  setFilterRepoIds
}: SidebarProjectFilterPanelProps): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [highlightedRepoId, setHighlightedRepoId] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // Why: `autoFocus` cannot survive here — it fires during commit, while the
  // root menu's trapped focus scope is still active and yanks focus back to the
  // sub-trigger (the submenu only pauses that scope in a later passive effect).
  // A frame later both focus scopes have settled, so this focus sticks.
  useEffect(() => {
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [])

  const handleSelectRepo = useCallback(
    (repoId: string) => {
      if (!filterRepoIds.includes(repoId)) {
        setFilterRepoIds([...filterRepoIds, repoId])
      }
      setQuery('')
    },
    [filterRepoIds, setFilterRepoIds]
  )

  const handleRemoveProject = useCallback(
    (repoId: string) => {
      setFilterRepoIds(filterRepoIds.filter((id) => id !== repoId))
    },
    [filterRepoIds, setFilterRepoIds]
  )

  const handleInputKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      // Why: this command is embedded in a Radix dropdown; text keys should
      // stay in the search field instead of triggering menu typeahead.
      if (event.key === 'Backspace' && query === '' && selectedRepos.length > 0) {
        const lastRepo = selectedRepos.at(-1)
        if (lastRepo) {
          event.preventDefault()
          event.stopPropagation()
          handleRemoveProject(lastRepo.id)
        }
        return
      }

      if (event.key === 'Enter') {
        const highlightedRepo = availableRepos.find((repo) => repo.id === highlightedRepoId)
        const repo = highlightedRepo ?? searchRepos(availableRepos, query)[0]
        if (repo) {
          event.preventDefault()
          event.stopPropagation()
          handleSelectRepo(repo.id)
        }
        return
      }

      // Why: swallowing every ArrowLeft would trap keyboard users in the panel,
      // since that is the key Radix uses to step back to the parent menu. Only
      // claim it while the caret still has somewhere to move.
      if (event.key === 'ArrowLeft') {
        const { selectionStart, selectionEnd } = event.currentTarget
        const caretAtStart = selectionStart === 0 && selectionEnd === 0
        if (!caretAtStart) {
          event.stopPropagation()
        }
        return
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        event.stopPropagation()
      }
    },
    [availableRepos, handleRemoveProject, handleSelectRepo, highlightedRepoId, query, selectedRepos]
  )

  return (
    <Command
      filter={projectCommandFilter}
      onValueChange={setHighlightedRepoId}
      className="bg-transparent"
    >
      <SelectedProjectPills selectedRepos={selectedRepos} onRemoveProject={handleRemoveProject} />
      <CommandInput
        ref={inputRef}
        placeholder={
          selectedRepos.length > 0
            ? translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.5a273fbfce',
                'Add project...'
              )
            : translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.83a820fa71',
                'Filter projects...'
              )
        }
        value={query}
        onValueChange={setQuery}
        onKeyDown={handleInputKeyDown}
        className="h-8 py-2 text-xs"
        wrapperClassName="mx-1 rounded-[7px] border border-border/70 px-2"
        iconClassName="h-3.5 w-3.5"
      />
      <CommandList className="max-h-48 py-1">
        <CommandEmpty className="py-4 text-[11px]">
          {hasRepoFilter
            ? translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.bbbc6e8e3b',
                'No unselected projects match'
              )
            : translate(
                'auto.components.sidebar.SidebarRepositoryFilterSection.4815c70605',
                'No projects match'
              )}
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
              <RepoBadgeLabel
                name={repo.displayName}
                color={repo.badgeColor}
                className="max-w-full"
              />
              {repo.connectionId && (
                <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                  <Server className="size-2.5" />
                  {translate(
                    'auto.components.sidebar.SidebarRepositoryFilterSection.2656053db4',
                    'SSH'
                  )}
                </span>
              )}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  )
}

function SelectedProjectPills({
  selectedRepos,
  onRemoveProject
}: {
  selectedRepos: Repo[]
  onRemoveProject: (repoId: string) => void
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
          <RepoBadgeLabel
            name={repo.displayName}
            color={repo.badgeColor}
            className="max-w-[8rem]"
            badgeClassName="size-1.5"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate(
              'auto.components.sidebar.SidebarRepositoryFilterSection.f10ca29601',
              'Remove {{value0}} filter',
              { value0: repo.displayName }
            )}
            className="-mr-1 size-4 rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onRemoveProject(repo.id)}
          >
            <X className="size-2.5" strokeWidth={2.5} />
          </Button>
        </Badge>
      ))}
    </div>
  )
}

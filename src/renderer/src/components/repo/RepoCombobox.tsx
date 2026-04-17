import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, FolderPlus, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAppStore } from '@/store'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import { searchRepos } from '@/lib/repo-search'
import { cn } from '@/lib/utils'
import type { Repo } from '../../../../shared/types'
import RepoDotLabel from './RepoDotLabel'

type RepoComboboxProps = {
  repos: Repo[]
  value: string
  onValueChange: (repoId: string) => void
  placeholder?: string
  triggerClassName?: string
}

export default function RepoCombobox({
  repos,
  value,
  onValueChange,
  placeholder = 'Select repo...',
  triggerClassName
}: RepoComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Why: controlled cmdk selection so hovering the footer (which lives outside
  // the cmdk tree) can clear the list's highlighted item — otherwise cmdk keeps
  // the last-hovered repo visually selected while the mouse is on the footer.
  const [commandValue, setCommandValue] = useState('')
  const addRepo = useAppStore((s) => s.addRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [isAdding, setIsAdding] = useState(false)

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === value) ?? null,
    [repos, value]
  )
  const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    // Why: the create-worktree dialog delays its own field reset until after
    // close animation, so the repo picker must clear its local filter here or a
    // stale query can reopen to an apparently missing repo list.
    if (!nextOpen) {
      setQuery('')
    }
  }, [])

  const handleSelect = useCallback(
    (repoId: string) => {
      onValueChange(repoId)
      setOpen(false)
      setQuery('')
    },
    [onValueChange]
  )

  const handleAddFolder = useCallback(async () => {
    if (isAdding) {
      return
    }
    setIsAdding(true)
    try {
      const repo = await addRepo()
      if (repo) {
        if (isGitRepoKind(repo)) {
          await fetchWorktrees(repo.id)
        }
        onValueChange(repo.id)
        setOpen(false)
        setQuery('')
      }
    } finally {
      setIsAdding(false)
    }
  }, [addRepo, fetchWorktrees, isAdding, onValueChange])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-8 w-full justify-between px-3 text-xs font-normal', triggerClassName)}
          data-repo-combobox-root="true"
        >
          {selectedRepo ? (
            <span className="inline-flex min-w-0 items-center gap-1.5">
              <RepoDotLabel
                name={selectedRepo.displayName}
                color={selectedRepo.badgeColor}
                dotClassName="size-1.5"
              />
              {selectedRepo.connectionId && (
                <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                  <Globe className="size-2.5" />
                  SSH
                </span>
              )}
            </span>
          ) : (
            <span className="text-muted-foreground">{placeholder}</span>
          )}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] p-0"
        data-repo-combobox-root="true"
      >
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder="Search repos/folders..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No repos/folders match your search.</CommandEmpty>
            {filteredRepos.map((repo) => (
              <CommandItem
                key={repo.id}
                value={repo.id}
                onSelect={() => handleSelect(repo.id)}
                className="items-center gap-2 px-3 py-2"
              >
                <Check
                  className={cn(
                    'size-4 text-foreground',
                    value === repo.id ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <div className="min-w-0 flex-1">
                  <span className="inline-flex items-center gap-1.5">
                    <RepoDotLabel
                      name={repo.displayName}
                      color={repo.badgeColor}
                      className="max-w-full"
                    />
                    {repo.connectionId && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                        <Globe className="size-2.5" />
                        SSH
                      </span>
                    )}
                  </span>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{repo.path}</p>
                </div>
              </CommandItem>
            ))}
          </CommandList>
          {/* Why: pinned footer (outside CommandList's scroll container) so the
              add action stays visible regardless of list length or scroll position. */}
          <div className="border-t border-border">
            <button
              type="button"
              disabled={isAdding}
              onClick={handleAddFolder}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCommandValue('')}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FolderPlus className="size-3.5 text-muted-foreground" />
              <span>{isAdding ? 'Adding folder/repo…' : 'Add folder/repo'}</span>
            </button>
          </div>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

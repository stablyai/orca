import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Globe } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { searchRepos } from '@/lib/repo-search'
import { cn } from '@/lib/utils'
import type { Repo } from '../../../../shared/types'
import RepoDotLabel from './RepoDotLabel'

type RepoComboboxProps = {
  repos: Repo[]
  value: string
  onValueChange: (repoId: string) => void
  placeholder?: string
}

export default function RepoCombobox({
  repos,
  value,
  onValueChange,
  placeholder = 'Select repo...'
}: RepoComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

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

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-8 w-full justify-between px-3 text-xs font-normal"
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
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder="Search repositories..."
            value={query}
            onValueChange={setQuery}
          />
          <CommandList>
            <CommandEmpty>No repositories match your search.</CommandEmpty>
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
        </Command>
      </PopoverContent>
    </Popover>
  )
}

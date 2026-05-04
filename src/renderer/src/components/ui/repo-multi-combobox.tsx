import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Server } from 'lucide-react'
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
import RepoDotLabel from '@/components/repo/RepoDotLabel'

type RepoMultiComboboxProps = {
  repos: Repo[]
  /** Currently selected repo ids. The component enforces `selected.size >= 1`
   *  by disabling the last-selected checkbox. */
  selected: ReadonlySet<string>
  /** Called with the next full selection set whenever the user changes it.
   *  `null` is never emitted here — persistence of "sticky-all" (selection
   *  equals every eligible repo) is the caller's responsibility. */
  onChange: (next: ReadonlySet<string>) => void
  /** Clicking the sticky "All repos" row emits a full-set selection AND this
   *  signal, so the caller can persist `null` (sticky-all) rather than a
   *  frozen snapshot that would exclude repos added later. */
  onSelectAll: () => void
  triggerClassName?: string
}

function renderTriggerLabel(repos: Repo[], selected: ReadonlySet<string>): React.JSX.Element {
  if (repos.length === 0) {
    return <span className="text-muted-foreground">No repos</span>
  }
  if (selected.size === repos.length) {
    return <span className="inline-flex min-w-0 items-center gap-1.5">All repos</span>
  }
  const selectedRepos = repos.filter((r) => selected.has(r.id))
  const [first, second, ...rest] = selectedRepos
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
      {first ? (
        <RepoDotLabel name={first.displayName} color={first.badgeColor} dotClassName="size-1.5" />
      ) : null}
      {second ? <span className="text-muted-foreground">, {second.displayName}</span> : null}
      {rest.length > 0 ? <span className="text-muted-foreground">+{rest.length}</span> : null}
    </span>
  )
}

export default function RepoMultiCombobox({
  repos,
  selected,
  onChange,
  onSelectAll,
  triggerClassName
}: RepoMultiComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState('')

  const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query])
  const allSelected = selected.size === repos.length && repos.length > 0

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
    }
  }, [])

  const toggle = useCallback(
    (repoId: string) => {
      const next = new Set(selected)
      if (next.has(repoId)) {
        // Why: the empty selection is unreachable by design — fetch effects
        // assume at least one repo is selected, so block the click instead of
        // silently allowing a no-op state.
        if (next.size <= 1) {
          return
        }
        next.delete(repoId)
      } else {
        next.add(repoId)
      }
      onChange(next)
    },
    [onChange, selected]
  )

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      // Why: toggle — clicking "All repos" while everything is selected
      // collapses to a single repo. The fetch effect requires at least one
      // selection, so we keep the first eligible repo instead of emitting
      // an empty set.
      const first = repos[0]
      if (!first) {
        return
      }
      onChange(new Set([first.id]))
      return
    }
    onSelectAll()
  }, [allSelected, onChange, onSelectAll, repos])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className={cn('h-8 w-full justify-between px-3 text-xs font-normal', triggerClassName)}
        >
          {renderTriggerLabel(repos, selected)}
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-0">
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder="Search repos..."
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          {/* Why: sticky "All repos" row sits above the CommandList so it
              stays visible while the user scrolls a long repo list. Selecting
              it emits `onSelectAll` (not a snapshot via onChange) so the
              caller can persist sticky-all semantics. */}
          <div className="border-b border-border">
            <button
              type="button"
              onClick={handleSelectAll}
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setCommandValue('')}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
                allSelected && 'opacity-80'
              )}
            >
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  allSelected ? 'opacity-70' : 'opacity-0'
                )}
              />
              <span>All repos</span>
            </button>
          </div>
          <CommandList>
            <CommandEmpty>No repos match your search.</CommandEmpty>
            {filteredRepos.map((repo) => {
              const isSelected = selected.has(repo.id)
              const isLastSelected = isSelected && selected.size <= 1
              return (
                <CommandItem
                  key={repo.id}
                  value={repo.id}
                  onSelect={() => toggle(repo.id)}
                  disabled={isLastSelected}
                  className="items-center gap-2 px-3 py-1.5 text-xs"
                >
                  <Check
                    className={cn(
                      'size-3 text-muted-foreground',
                      isSelected ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="inline-flex items-center gap-1.5 text-xs">
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
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{repo.path}</p>
                  </div>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

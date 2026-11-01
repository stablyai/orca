import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
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
import type { Repo } from '../../../../shared/repo-types'
import RepoBadgeLabel from '@/components/repo/RepoBadgeLabel'
import { translate } from '@/i18n/i18n'

type RepoMultiComboboxProps = {
  repos: readonly Repo[]
  /** Keep at least one repo selected by disabling its last checkbox. */
  selected: ReadonlySet<string>
  /** Emit a full selection, never null; the caller persists sticky-all as null. */
  onChange: (next: ReadonlySet<string>) => void
  /** Signal explicit All selection so persistence includes future repos rather than freezing this snapshot. */
  onSelectAll: () => void
  getRepoHostLabel?: (repo: Repo) => string | null | undefined
  triggerClassName?: string
}

function renderTriggerLabel(
  repos: readonly Repo[],
  selected: ReadonlySet<string>
): React.JSX.Element {
  if (repos.length === 0) {
    return (
      <span className="text-muted-foreground">
        {translate('auto.components.ui.repo.multi.combobox.65a3dae41d', 'No projects')}
      </span>
    )
  }
  if (selected.size === repos.length) {
    return (
      <span className="inline-flex min-w-0 items-center gap-1.5">
        {translate('auto.components.ui.repo.multi.combobox.bfd8ce21c6', 'All projects')}
      </span>
    )
  }
  const selectedRepos = repos.filter((r) => selected.has(r.id))
  const [first, second, ...rest] = selectedRepos
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 truncate">
      {first ? (
        <RepoBadgeLabel
          name={first.displayName}
          color={first.badgeColor}
          badgeClassName="size-1.5"
        />
      ) : null}
      {second ? <span className="text-muted-foreground">, {second.displayName}</span> : null}
      {rest.length > 0 ? <span className="text-muted-foreground">+{rest.length}</span> : null}
    </span>
  )
}

export function getRepoMultiComboboxDetail(repo: Repo, hostLabel?: string | null): string {
  const trimmedHostLabel = hostLabel?.trim()
  return trimmedHostLabel ? `${trimmedHostLabel} · ${repo.path}` : repo.path
}

export default function RepoMultiCombobox({
  repos,
  selected,
  onChange,
  onSelectAll,
  getRepoHostLabel,
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
        // Fetch effects require a nonempty selection; block the click rather than enter a no-op state.
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
      // Toggle All to the first eligible repo when already selected; never emit an empty set.
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
      {/* Use trigger width as a minimum, allowing search and repo paths to fit even when the trigger is short. */}
      <PopoverContent
        align="start"
        className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder={translate(
              'auto.components.ui.repo.multi.combobox.a58a0cd100',
              'Search projects...'
            )}
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          {/* Keep All above the scroller and signal sticky-all intent instead of emitting a frozen selection snapshot. */}
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
              <span>
                {translate('auto.components.ui.repo.multi.combobox.bfd8ce21c6', 'All projects')}
              </span>
            </button>
          </div>
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.ui.repo.multi.combobox.4471d4a1c0',
                'No projects match your search.'
              )}
            </CommandEmpty>
            {filteredRepos.map((repo) => {
              const isSelected = selected.has(repo.id)
              const isLastSelected = isSelected && selected.size <= 1
              const detail = getRepoMultiComboboxDetail(repo, getRepoHostLabel?.(repo))
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
                      <RepoBadgeLabel
                        name={repo.displayName}
                        color={repo.badgeColor}
                        className="max-w-full"
                      />
                    </span>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">{detail}</p>
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

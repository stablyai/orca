import React from 'react'
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
import { cn } from '@/lib/utils'
import type { Repo, Worktree } from '../../../../shared/types'
import { useAppStore } from '@/store'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'

const DEFAULT_VALUE = '__project_default__'

function displayBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '')
}

export function CreateFromPicker({
  repoId,
  repoMap,
  worktrees,
  value,
  triggerClassName,
  onValueChange
}: {
  repoId: string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  value: string
  triggerClassName?: string
  onValueChange: (baseBranch: string) => void
}): React.JSX.Element {
  const activeRuntimeEnvironmentId = useAppStore(
    (state) => state.settings?.activeRuntimeEnvironmentId ?? null
  )
  const repo = repoMap.get(repoId)
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const [defaultBaseRef, setDefaultBaseRef] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [searchResults, setSearchResults] = React.useState<string[]>([])
  const [isSearching, setIsSearching] = React.useState(false)
  const effectiveDefault = repo?.worktreeBaseRef ?? defaultBaseRef
  const selectedValue = value || DEFAULT_VALUE
  const selectedLabel =
    value || (effectiveDefault ? `${effectiveDefault} (default)` : 'Project default')
  const branchOptions = React.useMemo(() => {
    const options = new Set<string>()
    if (effectiveDefault) {
      options.add(effectiveDefault)
    }
    for (const worktree of worktrees) {
      const branch = displayBranchName(worktree.branch).trim()
      if (branch) {
        options.add(branch)
      }
    }
    for (const branch of searchResults) {
      options.add(branch)
    }
    return Array.from(options).sort((left, right) => left.localeCompare(right))
  }, [effectiveDefault, searchResults, worktrees])

  React.useEffect(() => {
    if (!open) {
      return
    }
    const frame = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  React.useEffect(() => {
    if (!repoId) {
      return
    }
    let stale = false
    setDefaultBaseRef(null)
    void getRuntimeRepoBaseRefDefault({ activeRuntimeEnvironmentId }, repoId)
      .then((result) => {
        if (!stale) {
          setDefaultBaseRef(result.defaultBaseRef)
        }
      })
      .catch(() => {
        if (!stale) {
          setDefaultBaseRef(null)
        }
      })
    return () => {
      stale = true
    }
  }, [activeRuntimeEnvironmentId, repoId])

  React.useEffect(() => {
    setQuery('')
    setSearchResults([])
    setIsSearching(false)
  }, [repoId])

  React.useEffect(() => {
    const trimmedQuery = query.trim()
    if (!open || !repoId || trimmedQuery.length < 2) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    let stale = false
    setIsSearching(true)
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefs({ activeRuntimeEnvironmentId }, repoId, trimmedQuery, 30)
        .then((results) => {
          if (!stale) {
            setSearchResults(results)
          }
        })
        .catch(() => {
          if (!stale) {
            setSearchResults([])
          }
        })
        .finally(() => {
          if (!stale) {
            setIsSearching(false)
          }
        })
    }, 200)

    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [activeRuntimeEnvironmentId, open, query, repoId])

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn('h-9 w-full justify-between px-3 text-sm font-normal', triggerClassName)}
          >
            <span className="truncate">{selectedLabel}</span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
          onOpenAutoFocus={(event) => event.preventDefault()}
        >
          <Command>
            <CommandInput
              ref={inputRef}
              value={query}
              onValueChange={setQuery}
              placeholder="Search repo branches..."
            />
            <CommandList className="max-h-72">
              <CommandEmpty>
                {isSearching ? 'Searching branches...' : 'No branches found.'}
              </CommandEmpty>
              <CommandItem
                value={effectiveDefault ? `${effectiveDefault} default` : 'project default'}
                onSelect={() => {
                  onValueChange('')
                  setOpen(false)
                }}
              >
                <Check
                  className={cn(
                    'size-4',
                    selectedValue === DEFAULT_VALUE ? 'opacity-100' : 'opacity-0'
                  )}
                />
                <span className="truncate">
                  {effectiveDefault ? `${effectiveDefault} (default)` : 'Project default'}
                </span>
              </CommandItem>
              {branchOptions
                .filter((branch) => branch !== effectiveDefault)
                .map((branch) => (
                  <CommandItem
                    key={branch}
                    value={branch}
                    onSelect={() => {
                      onValueChange(branch)
                      setOpen(false)
                    }}
                  >
                    <Check
                      className={cn('size-4', value === branch ? 'opacity-100' : 'opacity-0')}
                    />
                    <span className="truncate">{branch}</span>
                  </CommandItem>
                ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}

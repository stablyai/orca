/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: picker base-ref defaults and search results come from debounced runtime IPC, so loading/result state is intentionally synchronized from effects. */
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
import { getRuntimeEnvironmentIdForRepo } from '@/lib/repo-runtime-owner'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'
import { isRuntimeRepoRefSearchQueryWithinLimit } from '@/runtime/runtime-repo-search-bounds'
import { translate } from '@/i18n/i18n'

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
  const activeRuntimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForRepo(state, repoId)
  )
  const repo = repoMap.get(repoId)
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)
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

  const cancelFocusFrame = React.useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  const setInputNode = React.useCallback(
    (node: HTMLInputElement | null): void => {
      if (node === null) {
        cancelFocusFrame()
      }
      inputRef.current = node
    },
    [cancelFocusFrame]
  )

  const focusSearchInput = React.useCallback(() => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      inputRef.current?.focus()
    })
  }, [cancelFocusFrame])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        cancelFocusFrame()
      }
    },
    [cancelFocusFrame]
  )

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
    if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
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
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn('h-9 w-full justify-between px-3 text-sm font-normal', triggerClassName)}
          >
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="shrink-0 text-muted-foreground">
                {translate(
                  'auto.components.automations.CreateFromPicker.dd3841b442',
                  'Branch from'
                )}
              </span>
              <span className="truncate">{selectedLabel}</span>
            </span>
            <ChevronsUpDown className="size-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            focusSearchInput()
          }}
        >
          <Command>
            <CommandInput
              ref={setInputNode}
              value={query}
              onValueChange={setQuery}
              placeholder={translate(
                'auto.components.automations.CreateFromPicker.f061f49e3f',
                'Search repo branches...'
              )}
            />
            <CommandList className="max-h-72">
              <CommandEmpty>
                {isSearching
                  ? translate(
                      'auto.components.automations.CreateFromPicker.9ce96621f4',
                      'Searching branches...'
                    )
                  : translate(
                      'auto.components.automations.CreateFromPicker.79512f22a7',
                      'No branches found.'
                    )}
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
                  {effectiveDefault
                    ? translate(
                        'auto.components.automations.CreateFromPicker.e53d306056',
                        '{{value0}} (default)',
                        { value0: effectiveDefault }
                      )
                    : translate(
                        'auto.components.automations.CreateFromPicker.ef6d762538',
                        'Project default'
                      )}
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

/* oxlint-disable react-doctor/no-adjust-state-on-prop-change -- Why: base-ref defaults and branch search results are repo-scoped runtime data and must clear before each new request resolves. */
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
import { getRuntimeEnvironmentIdForRepo } from '@/lib/repo-runtime-owner'
import { cn } from '@/lib/utils'
import { useAppStore } from '@/store'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'
import { isRuntimeRepoRefSearchQueryWithinLimit } from '@/runtime/runtime-repo-search-bounds'
import { translate } from '@/i18n/i18n'

const DEFAULT_VALUE = '__project_default__'

type BaseBranchPickerProps = {
  repoId: string
  repoWorktreeBaseRef?: string | null
  value: string | undefined
  disabled?: boolean
  onValueChange: (baseBranch: string | undefined) => void
}

export default function BaseBranchPicker({
  repoId,
  repoWorktreeBaseRef,
  value,
  disabled = false,
  onValueChange
}: BaseBranchPickerProps): React.JSX.Element {
  const activeRuntimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForRepo(state, repoId)
  )
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)
  const [defaultBaseRef, setDefaultBaseRef] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [searchResults, setSearchResults] = React.useState<string[]>([])
  const [isSearching, setIsSearching] = React.useState(false)
  const effectiveDefault = repoWorktreeBaseRef?.trim() || defaultBaseRef
  const selectedValue = value ?? DEFAULT_VALUE
  const selectedLabel =
    value ??
    (effectiveDefault
      ? translate(
          'auto.components.newWorkspace.BaseBranchPicker.defaultBranch',
          '{{value0}} (default)',
          {
            value0: effectiveDefault
          }
        )
      : translate(
          'auto.components.newWorkspace.BaseBranchPicker.projectDefault',
          'Project default'
        ))
  const branchOptions = React.useMemo(() => {
    const options = new Set<string>()
    if (effectiveDefault) {
      options.add(effectiveDefault)
    }
    if (value) {
      options.add(value)
    }
    for (const branch of searchResults) {
      options.add(branch)
    }
    return Array.from(options).sort((left, right) => left.localeCompare(right))
  }, [effectiveDefault, searchResults, value])

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

  const clearSearchState = React.useCallback((): void => {
    setQuery('')
    setSearchResults([])
    setIsSearching(false)
  }, [])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean): void => {
      setOpen(nextOpen)
      if (!nextOpen) {
        cancelFocusFrame()
        clearSearchState()
      }
    },
    [cancelFocusFrame, clearSearchState]
  )

  React.useEffect(() => {
    clearSearchState()
  }, [activeRuntimeEnvironmentId, clearSearchState, repoId])

  React.useEffect(() => {
    if (!repoId || disabled) {
      setDefaultBaseRef(null)
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
  }, [activeRuntimeEnvironmentId, disabled, repoId])

  React.useEffect(() => {
    if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    const trimmedQuery = query.trim()
    if (!open || disabled || !repoId || trimmedQuery.length < 2) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    let stale = false
    setSearchResults([])
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
  }, [activeRuntimeEnvironmentId, disabled, open, query, repoId])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className="h-9 w-full justify-between px-3 text-sm font-normal"
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-muted-foreground">
              {translate('auto.components.newWorkspace.BaseBranchPicker.branchFrom', 'Branch from')}
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
              'auto.components.newWorkspace.BaseBranchPicker.searchBranches',
              'Search repo branches...'
            )}
          />
          <CommandList className="max-h-72">
            <CommandEmpty>
              {isSearching
                ? translate(
                    'auto.components.newWorkspace.BaseBranchPicker.searchingBranches',
                    'Searching branches...'
                  )
                : translate(
                    'auto.components.newWorkspace.BaseBranchPicker.noBranchesFound',
                    'No branches found.'
                  )}
            </CommandEmpty>
            <CommandItem
              value={effectiveDefault ? `${effectiveDefault} default` : 'project default'}
              onSelect={() => {
                onValueChange(undefined)
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
                      'auto.components.newWorkspace.BaseBranchPicker.defaultBranch',
                      '{{value0}} (default)',
                      { value0: effectiveDefault }
                    )
                  : translate(
                      'auto.components.newWorkspace.BaseBranchPicker.projectDefault',
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
                  <Check className={cn('size-4', value === branch ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{branch}</span>
                </CommandItem>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

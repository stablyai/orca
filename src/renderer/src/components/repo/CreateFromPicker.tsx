import React from 'react'
import { Check, ChevronsUpDown, GitBranch, Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForRepo } from '@/lib/repo-runtime-owner'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/runtime-repo-client'
import { isRuntimeRepoRefSearchQueryWithinLimit } from '@/runtime/runtime-repo-search-bounds'
import { translate } from '@/i18n/i18n'
import { FilePathCursorTooltip } from '@/components/file-path-cursor-tooltip'

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
  compact = false,
  readOnly = false,
  onValueChange,
  onSetDefault
}: {
  repoId: string
  repoMap: Map<string, Repo>
  worktrees: Worktree[]
  value: string
  triggerClassName?: string
  compact?: boolean
  readOnly?: boolean
  onValueChange: (baseBranch: string) => void
  onSetDefault?: (baseBranch: string) => void | Promise<void>
}): React.JSX.Element {
  // Per-repo evidence, not the ambient active-runtime setting; the base-ref helpers
  // just take a settings-shaped object, so it is synthesized at each call below.
  const repoRuntimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForRepo(state, repoId)
  )
  const repo = repoMap.get(repoId)
  const repoHostId = repo ? getRepoExecutionHostId(repo) : undefined
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)
  const [defaultBaseRef, setDefaultBaseRef] = React.useState<string | null>(null)
  const [query, setQuery] = React.useState('')
  const [searchResults, setSearchResults] = React.useState<string[]>([])
  const [isSearching, setIsSearching] = React.useState(false)
  const listId = React.useId()
  const effectiveDefault = repo?.worktreeBaseRef ?? defaultBaseRef
  const selectedValue = value || DEFAULT_VALUE
  const projectDefaultLabel = translate(
    'auto.components.automations.CreateFromPicker.ef6d762538',
    'Project default'
  )
  const selectedLabel =
    value || (effectiveDefault ? `${effectiveDefault} (default)` : projectDefaultLabel)
  const compactLabel = value || effectiveDefault || projectDefaultLabel
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

  const renderBranchContextMenu = React.useCallback(
    (branch: string, row: React.ReactNode): React.ReactNode => {
      if (!onSetDefault || !branch) {
        return row
      }
      const isDefault = branch === effectiveDefault
      return (
        <ContextMenu key={branch}>
          <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
          <ContextMenuContent className="z-[70]">
            <ContextMenuItem
              disabled={isDefault}
              onSelect={() => {
                void onSetDefault(branch)
              }}
            >
              <Star className="size-3.5" />
              {isDefault
                ? translate('auto.components.agent.AgentCombobox.1b0d6965fa', 'Current default')
                : translate('auto.components.agent.AgentCombobox.9c6b59fe58', 'Set as default')}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      )
    },
    [effectiveDefault, onSetDefault]
  )

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
    void getRuntimeRepoBaseRefDefault(
      { activeRuntimeEnvironmentId: repoRuntimeEnvironmentId },
      repoId,
      repoHostId
    )
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
  }, [repoHostId, repoRuntimeEnvironmentId, repoId])

  React.useEffect(() => {
    if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    const trimmedQuery = query.trim()
    // Why: an empty query lists the repo's branches, as the composer's Branch tab already does;
    // a minimum length left this picker showing only the default and worktree branches.
    if (!open || !repoId) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    let stale = false
    setIsSearching(true)
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefs(
        { activeRuntimeEnvironmentId: repoRuntimeEnvironmentId },
        repoId,
        trimmedQuery,
        30,
        repoHostId
      )
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
  }, [repoHostId, repoRuntimeEnvironmentId, open, query, repoId])

  const compactTriggerContent = (
    <>
      <GitBranch className="size-3 shrink-0" aria-hidden="true" />
      <FilePathCursorTooltip path={compactLabel}>
        <span className="min-w-0 truncate font-mono">{compactLabel}</span>
      </FilePathCursorTooltip>
      {!readOnly ? <ChevronsUpDown className="size-3 shrink-0 opacity-60" /> : null}
    </>
  )
  const trigger = compact ? (
    readOnly ? (
      <span
        aria-label={`${translate('auto.components.automations.CreateFromPicker.dd3841b442', 'Branch from')}: ${compactLabel}`}
        className={cn(
          'inline-flex h-6 max-w-44 items-center gap-1 rounded-md border border-border bg-muted/30 px-1.5 text-[11px] text-muted-foreground opacity-70',
          triggerClassName
        )}
      >
        {compactTriggerContent}
      </span>
    ) : (
      <button
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={translate(
          'auto.components.automations.CreateFromPicker.dd3841b442',
          'Branch from'
        )}
        className={cn(
          'inline-flex h-6 max-w-44 items-center gap-1 rounded-md border border-border bg-muted/30 px-1.5 text-[11px] text-muted-foreground',
          'cursor-pointer hover:bg-accent hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          triggerClassName
        )}
      >
        {compactTriggerContent}
      </button>
    )
  ) : (
    <Button
      type="button"
      variant="outline"
      role="combobox"
      aria-expanded={open}
      className={cn('h-9 w-full justify-between px-3 text-sm font-normal', triggerClassName)}
    >
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-muted-foreground">
          {translate('auto.components.automations.CreateFromPicker.dd3841b442', 'Branch from')}
        </span>
        <span className="truncate">{selectedLabel}</span>
      </span>
      <ChevronsUpDown className="size-4 opacity-50" />
    </Button>
  )

  return (
    <div className="space-y-2">
      {readOnly ? (
        trigger
      ) : (
        <Popover open={open} onOpenChange={handleOpenChange}>
          <PopoverTrigger asChild>{trigger}</PopoverTrigger>
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
              <CommandList id={listId} className="max-h-72">
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
                {renderBranchContextMenu(
                  effectiveDefault ?? '',
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
                    <FilePathCursorTooltip path={effectiveDefault ?? projectDefaultLabel}>
                      <span className="min-w-0 truncate">
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
                    </FilePathCursorTooltip>
                  </CommandItem>
                )}
                {branchOptions
                  .filter((branch) => branch !== effectiveDefault)
                  .map((branch) =>
                    renderBranchContextMenu(
                      branch,
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
                        <FilePathCursorTooltip path={branch}>
                          <span className="min-w-0 truncate">{branch}</span>
                        </FilePathCursorTooltip>
                      </CommandItem>
                    )
                  )}
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

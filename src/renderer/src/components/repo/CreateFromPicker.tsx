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
import { cn } from '@/lib/class-names'
import {
  branchRefLabel,
  branchRefLabels,
  probedDefaultBranchRef
} from '../../../../shared/git/refs/branch-ref-label'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import {
  getRuntimeRepoBaseRefDefault,
  searchRuntimeRepoBaseRefs
} from '@/runtime/source-control/references/runtime-repo-client'
import { isRuntimeRepoRefSearchQueryWithinLimit } from '@/runtime/source-control/references/runtime-repo-search-bounds'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { FilePathCursorTooltip } from '@/components/file-path-cursor-tooltip'

const DEFAULT_VALUE = '__project_default__'

function createBranchOptions(
  effectiveDefault: string | null,
  searchResults: readonly string[],
  worktrees: readonly Worktree[]
) {
  const options = new Set<string>()
  if (effectiveDefault) {
    options.add(effectiveDefault)
  }
  for (const worktree of worktrees) {
    const branch = worktree.branch.trim().replace(/^refs\/heads\//, '')
    if (branch) {
      options.add(searchResults.includes(branch) ? branch : `refs/heads/${branch}`)
    }
  }
  for (const branch of searchResults) {
    options.add(branch)
  }
  const merged = Array.from(options)
  const labels = branchRefLabels(merged)
  merged.sort((left, right) => (labels.get(left) ?? left).localeCompare(labels.get(right) ?? right))
  return { options: merged, labels }
}

function cancelFocusFrame(frame: { current: number | null }): void {
  if (frame.current !== null) {
    cancelAnimationFrame(frame.current)
    frame.current = null
  }
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
  const t = useTranslate()
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
  const effectiveDefault =
    repo?.worktreeBaseRef ?? probedDefaultBranchRef(defaultBaseRef, searchResults)
  const selectedValue = value || DEFAULT_VALUE
  const projectDefaultLabel = t(
    'auto.components.automations.CreateFromPicker.ef6d762538',
    'Project default'
  )
  const selectedLabel =
    (value ? branchRefLabel(value) : null) ||
    (effectiveDefault ? `${branchRefLabel(effectiveDefault)} (default)` : projectDefaultLabel)
  const compactLabel = value
    ? branchRefLabel(value)
    : effectiveDefault
      ? branchRefLabel(effectiveDefault)
      : projectDefaultLabel
  const { options: branchOptions, labels } = createBranchOptions(
    effectiveDefault,
    searchResults,
    worktrees
  )

  function renderBranchContextMenu(branch: string, row: React.ReactNode): React.ReactNode {
    if (!onSetDefault || !branch) {
      return row
    }
    const isDefault = effectiveDefault === branch
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
  }

  const setInputNode = React.useCallback(
    (node: HTMLInputElement | null): void => {
      if (node === null) {
        cancelFocusFrame(focusFrameRef)
      }
      inputRef.current = node
    },
    [focusFrameRef, inputRef]
  )

  const focusSearchInput = React.useCallback(() => {
    cancelFocusFrame(focusFrameRef)
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      inputRef.current?.focus()
    })
  }, [focusFrameRef, inputRef])

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (!nextOpen) {
        cancelFocusFrame(focusFrameRef)
      }
    },
    [focusFrameRef]
  )

  React.useEffect(() => {
    if (!repoId || !repoHostId) {
      return
    }
    let stale = false
    setDefaultBaseRef(null)
    void getRuntimeRepoBaseRefDefault(repoHostId, repoId)
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
  }, [repoHostId, repoId])

  React.useEffect(() => {
    if (!isRuntimeRepoRefSearchQueryWithinLimit(query)) {
      setSearchResults([])
      setIsSearching(false)
      return
    }
    const trimmedQuery = query.trim()
    // List branches on empty queries too; minimum query length would hide nondefault branches without worktrees.
    if (!open || !repoId || !repoHostId) {
      setSearchResults([])
      setIsSearching(false)
      return
    }

    let stale = false
    setIsSearching(true)
    const timer = window.setTimeout(() => {
      void searchRuntimeRepoBaseRefs(repoHostId, repoId, trimmedQuery, 30)
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
  }, [repoHostId, open, query, repoId])

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
        aria-label={`${t('auto.components.automations.CreateFromPicker.dd3841b442', 'Branch from')}: ${compactLabel}`}
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
        aria-label={t('auto.components.automations.CreateFromPicker.dd3841b442', 'Branch from')}
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
          {t('auto.components.automations.CreateFromPicker.dd3841b442', 'Branch from')}
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
                placeholder={t(
                  'auto.components.automations.CreateFromPicker.f061f49e3f',
                  'Search repo branches...'
                )}
              />
              <CommandList id={listId} className="max-h-72">
                <CommandEmpty>
                  {isSearching
                    ? t(
                        'auto.components.automations.CreateFromPicker.9ce96621f4',
                        'Searching branches...'
                      )
                    : t(
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
                          ? t(
                              'auto.components.automations.CreateFromPicker.e53d306056',
                              '{{value0}} (default)',
                              { value0: branchRefLabel(effectiveDefault) }
                            )
                          : t(
                              'auto.components.automations.CreateFromPicker.ef6d762538',
                              'Project default'
                            )}
                      </span>
                    </FilePathCursorTooltip>
                  </CommandItem>
                )}
                {branchOptions
                  .filter((branch) => !(effectiveDefault === branch))
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
                          <span className="min-w-0 truncate">{labels.get(branch)}</span>
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

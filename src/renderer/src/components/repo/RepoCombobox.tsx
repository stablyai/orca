import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, FolderPlus, Server } from 'lucide-react'
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
import { useMountedRef } from '@/hooks/useMountedRef'
import type { Repo } from '../../../../shared/repo-types'
import RepoBadgeLabel from './RepoBadgeLabel'
import { translate } from '@/i18n/i18n'

type RepoComboboxProps = {
  repos: readonly Repo[]
  value: string
  onValueChange: (repoId: string) => void
  onValueSelected?: (repoId: string) => void
  placeholder?: string
  triggerClassName?: string
  autoOpenOnMount?: boolean
  showStandaloneAddButton?: boolean
  invalid?: boolean
  describedBy?: string
}

export default function RepoCombobox({
  repos,
  value,
  onValueChange,
  onValueSelected,
  placeholder = 'Select repo...',
  triggerClassName,
  autoOpenOnMount = false,
  showStandaloneAddButton = true,
  invalid = false,
  describedBy
}: RepoComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(autoOpenOnMount)
  const [query, setQuery] = useState('')
  // Control cmdk selection so hovering the external footer can clear the last repo highlight.
  const [commandValue, setCommandValue] = useState(() => (autoOpenOnMount ? value : ''))
  const addRepo = useAppStore((s) => s.addRepo)
  const fetchWorktrees = useAppStore((s) => s.fetchWorktrees)
  const [isAdding, setIsAdding] = useState(false)
  const triggerRef = React.useRef<HTMLButtonElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)
  const mountedRef = useMountedRef()

  const selectedRepo = useMemo(
    () => repos.find((repo) => repo.id === value) ?? null,
    [repos, value]
  )
  const filteredRepos = useMemo(() => searchRepos(repos, query), [repos, query])

  const cancelFocusFrame = useCallback((): void => {
    if (focusFrameRef.current !== null) {
      cancelAnimationFrame(focusFrameRef.current)
      focusFrameRef.current = null
    }
  }, [])

  const setInputNode = useCallback(
    (node: HTMLInputElement | null): void => {
      if (node === null) {
        cancelFocusFrame()
      }
      inputRef.current = node
    },
    [cancelFocusFrame]
  )

  const focusSearchInput = useCallback(() => {
    cancelFocusFrame()
    focusFrameRef.current = requestAnimationFrame(() => {
      focusFrameRef.current = null
      const repoSearchInput = inputRef.current
      if (!repoSearchInput) {
        return
      }
      repoSearchInput.focus()
      // Seeded trigger typing must append on the next key; place the caret at the query’s end.
      const end = repoSearchInput.value.length
      repoSearchInput.setSelectionRange(end, end)
    })
  }, [cancelFocusFrame])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        setCommandValue(value)
        return
      }
      cancelFocusFrame()
      // Clear local filtering on close; the dialog’s delayed reset could otherwise reopen with an apparently missing list.
      setQuery('')
    },
    [cancelFocusFrame, value]
  )

  const handleSelect = useCallback(
    (repoId: string) => {
      onValueChange(repoId)
      setOpen(false)
      setQuery('')
      onValueSelected?.(repoId)
    },
    [onValueChange, onValueSelected]
  )

  // Button focus keeps the committed pick; arrows explicitly open, while printable keys open a new seeded search.
  const handleTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (open) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        setCommandValue(value)
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      // Preserve native Space/Enter click semantics instead of inserting whitespace into search.
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setCommandValue(value)
        setQuery(event.key)
        setOpen(true)
      }
    },
    [open, value]
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
        if (!mountedRef.current) {
          return
        }
        onValueChange(repo.id)
        setOpen(false)
        setQuery('')
      }
    } finally {
      if (mountedRef.current) {
        setIsAdding(false)
      }
    }
  }, [addRepo, fetchWorktrees, isAdding, mountedRef, onValueChange])

  return (
    <div className="flex w-full items-center gap-1.5">
      <Popover open={open} onOpenChange={handleOpenChange}>
        <PopoverTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-invalid={invalid ? true : undefined}
            aria-describedby={describedBy}
            onKeyDown={handleTriggerKeyDown}
            className={cn(
              'h-8 min-w-[184px] justify-between px-3 text-xs font-normal',
              triggerClassName
            )}
            data-repo-combobox-root="true"
          >
            {selectedRepo ? (
              <span className="inline-flex min-w-0 items-center gap-1.5">
                <RepoBadgeLabel
                  name={selectedRepo.displayName}
                  color={selectedRepo.badgeColor}
                  badgeClassName="size-1.5"
                />
                {selectedRepo.connectionId && (
                  <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                    <Server className="size-2.5" />
                    {translate('auto.components.repo.RepoCombobox.3639fd9da2', 'SSH')}
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
          className="w-[var(--radix-popover-trigger-width)] min-w-[18rem] p-0"
          data-repo-combobox-root="true"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            focusSearchInput()
          }}
        >
          <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
            <CommandInput
              ref={setInputNode}
              placeholder={translate(
                'auto.components.repo.RepoCombobox.a0c48f5f29',
                'Search projects/folders...'
              )}
              value={query}
              onValueChange={setQuery}
            />
            <CommandList>
              <CommandEmpty>
                {translate(
                  'auto.components.repo.RepoCombobox.e7ed739236',
                  'No projects/folders match your search.'
                )}
              </CommandEmpty>
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
                      <RepoBadgeLabel
                        name={repo.displayName}
                        color={repo.badgeColor}
                        className="max-w-full"
                      />
                      {repo.connectionId && (
                        <span className="shrink-0 inline-flex items-center gap-0.5 rounded bg-muted px-1 py-0.5 text-[9px] font-medium leading-none text-muted-foreground">
                          <Server className="size-2.5" />
                          {translate('auto.components.repo.RepoCombobox.3639fd9da2', 'SSH')}
                        </span>
                      )}
                    </span>
                    <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{repo.path}</p>
                  </div>
                </CommandItem>
              ))}
            </CommandList>
            {/* Retain the historical Add footer alongside the compact header action. */}
            <div className="border-t border-border">
              <Button
                type="button"
                variant="ghost"
                disabled={isAdding}
                onClick={() => void handleAddFolder()}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setCommandValue('')}
                className="h-9 w-full justify-start rounded-none px-3 text-xs font-normal"
              >
                <FolderPlus className="size-3.5 text-muted-foreground" />
                <span>
                  {isAdding
                    ? translate('auto.components.repo.RepoCombobox.116812151a', 'Adding project…')
                    : translate('auto.components.repo.RepoCombobox.b3e15f4525', 'Add project')}
                </span>
              </Button>
            </div>
          </Command>
        </PopoverContent>
      </Popover>

      {showStandaloneAddButton ? (
        /* Keep Add project reachable when the compact composer hides the selector. */
        <Button
          type="button"
          variant="outline"
          size="default"
          disabled={isAdding}
          onClick={() => void handleAddFolder()}
          className="size-9 shrink-0 p-0"
          aria-label={
            isAdding
              ? translate('auto.components.repo.RepoCombobox.b4a235e886', 'Adding project')
              : translate('auto.components.repo.RepoCombobox.b3e15f4525', 'Add project')
          }
        >
          <FolderPlus className="size-3.5" />
        </Button>
      ) : null}
    </div>
  )
}

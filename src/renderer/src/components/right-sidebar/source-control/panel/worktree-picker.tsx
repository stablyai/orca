import React, { useCallback, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Eye, Workflow } from 'lucide-react'
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
import { translate } from '@/i18n/i18n'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { getWorktreeGitIdentityDisplay } from '@/lib/worktree-git-identity-display'
import { filterSourceControlWorktrees } from './worktree-picker-filter'

type SourceControlWorktreePickerProps = {
  /** Every worktree of the active repo, including the main checkout. */
  worktrees: readonly Worktree[]
  /** The worktree the panel is currently showing. */
  selectedWorktreeId: string
  /** The app-active worktree; rendered as the "current" row in the list. */
  currentWorktreeId: string
  onSelect: (worktreeId: string) => void
}

function resolvePickerTriggerLabel(worktrees: readonly Worktree[], worktreeId: string): string {
  return worktrees.find((worktree) => worktree.id === worktreeId)?.displayName ?? ''
}

export function SourceControlWorktreePicker({
  worktrees,
  selectedWorktreeId,
  currentWorktreeId,
  onSelect
}: SourceControlWorktreePickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selectedWorktree = useMemo(
    () => worktrees.find((worktree) => worktree.id === selectedWorktreeId) ?? null,
    [selectedWorktreeId, worktrees]
  )
  const viewingNonActive = selectedWorktreeId !== currentWorktreeId
  // Why: keep the repo's main checkout pinned at the top; the rest alphabetical so the list is stable.
  const orderedWorktrees = useMemo(
    () =>
      [...worktrees].sort(
        (left, right) =>
          Number(right.isMainWorktree) - Number(left.isMainWorktree) ||
          left.displayName.localeCompare(right.displayName)
      ),
    [worktrees]
  )
  const filteredWorktrees = useMemo(
    () => filterSourceControlWorktrees(orderedWorktrees, query),
    [orderedWorktrees, query]
  )
  const triggerLabel = resolvePickerTriggerLabel(worktrees, selectedWorktreeId)
  const triggerTitle = translate(
    'auto.components.right.sidebar.SourceControl.worktreePickerTriggerTitle',
    'Worktree: {{value0}}',
    { value0: triggerLabel || selectedWorktree?.path || '' }
  )

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
    }
  }, [])

  const handleSelect = useCallback(
    (worktreeId: string) => {
      if (worktreeId !== selectedWorktreeId) {
        onSelect(worktreeId)
      }
      setOpen(false)
    },
    [onSelect, selectedWorktreeId]
  )

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          role="combobox"
          aria-expanded={open}
          aria-label={triggerTitle}
          title={triggerTitle}
          data-testid="source-control-worktree-picker"
          className="h-6 min-w-0 max-w-[160px] shrink-0 px-2 text-[11px] font-normal"
        >
          {viewingNonActive ? (
            <Eye
              className="size-3 shrink-0 text-amber-600 dark:text-amber-400"
              aria-hidden="true"
            />
          ) : (
            <Workflow className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="min-w-0 flex-1 truncate">{triggerLabel || selectedWorktree?.path}</span>
          <ChevronsUpDown className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            autoFocus
            placeholder={translate(
              'auto.components.right.sidebar.SourceControl.worktreePickerSearchPlaceholder',
              'Search worktrees…'
            )}
            value={query}
            onValueChange={setQuery}
            className="text-xs"
          />
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.right.sidebar.SourceControl.worktreePickerEmpty',
                'No worktrees match your search.'
              )}
            </CommandEmpty>
            {filteredWorktrees.map((worktree) => {
              const isSelected = worktree.id === selectedWorktreeId
              const isCurrent = worktree.id === currentWorktreeId
              const identity = getWorktreeGitIdentityDisplay(worktree)
              const headLabel =
                identity?.kind === 'branch'
                  ? identity.branchName
                  : identity?.kind === 'detached'
                    ? identity.sourceControlLabel
                    : null
              return (
                <CommandItem
                  key={worktree.id}
                  value={worktree.id}
                  onSelect={() => handleSelect(worktree.id)}
                  className="items-center gap-2 px-3 py-1.5 text-xs"
                  data-testid={`source-control-worktree-picker-option-${worktree.id}`}
                >
                  <Check
                    className={cn(
                      'size-3 shrink-0 text-muted-foreground',
                      isSelected ? 'opacity-70' : 'opacity-0'
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-xs">{worktree.displayName}</span>
                      {worktree.isMainWorktree ? (
                        <span className="shrink-0 rounded-sm bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                          {translate(
                            'auto.components.right.sidebar.SourceControl.worktreePickerMainBadge',
                            'Main'
                          )}
                        </span>
                      ) : null}
                      {isCurrent ? (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {translate(
                            'auto.components.right.sidebar.SourceControl.worktreePickerCurrentBadge',
                            'Current'
                          )}
                        </span>
                      ) : null}
                    </span>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {headLabel ? <span className="font-mono">{headLabel} · </span> : null}
                      <span className="font-mono">{worktree.path}</span>
                    </p>
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

export function shouldShowSourceControlNonActiveWorktreeNotice(
  selectedWorktreeId: string,
  currentWorktreeId: string
): boolean {
  return selectedWorktreeId !== currentWorktreeId
}

export function SourceControlNonActiveWorktreeNotice({
  displayName,
  className
}: {
  displayName: string
  className?: string
}): React.JSX.Element {
  return (
    <div
      role="status"
      data-testid="source-control-non-active-worktree-notice"
      className={cn(
        'flex items-center gap-1.5 border-b border-border bg-muted/40 px-3 py-1 text-[10.5px] text-muted-foreground',
        className
      )}
    >
      <Eye className="size-3 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden="true" />
      <span className="min-w-0 truncate">
        {translate(
          'auto.components.right.sidebar.SourceControl.worktreePickerNonActiveNotice',
          'Viewing {{value0}} — changes and commits shown for this worktree',
          { value0: displayName }
        )}
      </span>
    </div>
  )
}

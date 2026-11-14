import React from 'react'
import { defaultFilter } from 'cmdk'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandList, CommandOption } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import {
  getWindowedCommandNavigation,
  useCommandInputActiveDescendant
} from '@/lib/list-interaction/windowed-command-navigation'
import { useWindowedCommandVirtualizer } from '@/lib/list-interaction/use-windowed-command-virtualizer'
import type { Worktree } from '../../../../../shared/worktree/types'
import { useTranslate } from '@/i18n/use-translate'

// Why: `py-1.5` around a 20px text line; fixed so rows never need measuring.
const WORKSPACE_OPTION_HEIGHT = 32
const WORKSPACE_OPTION_OVERSCAN = 8
// Why: matches `max-h-72`; seeds the first paint before the popover measures.
const WORKSPACE_LIST_MAX_HEIGHT = 288

function estimateWorkspaceOptionSize(): number {
  return WORKSPACE_OPTION_HEIGHT
}

/** cmdk's own ranking, run over every worktree so windowing never drops a match. */
function filterWorkspaces(worktrees: readonly Worktree[], query: string): readonly Worktree[] {
  if (!query) {
    return worktrees
  }
  return worktrees
    .map((worktree) => ({ worktree, score: defaultFilter(worktree.displayName.trim(), query, []) }))
    .filter((scored) => scored.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.worktree)
}

function WorkspaceComboboxList({
  worktrees,
  value,
  setInputNode,
  onSelect
}: {
  worktrees: Worktree[]
  value: string
  setInputNode: (node: HTMLInputElement | null) => void
  onSelect: (workspaceId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const listRef = React.useRef<HTMLDivElement | null>(null)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const optionIdPrefix = `${React.useId()}option`
  const [query, setQuery] = React.useState('')
  const [highlightedId, setHighlightedId] = React.useState<string | null>(null)

  const filtered = React.useMemo(() => filterWorkspaces(worktrees, query), [worktrees, query])
  const itemIds = React.useMemo(() => filtered.map((worktree) => worktree.id), [filtered])
  const indexById = React.useMemo(() => new Map(itemIds.map((id, index) => [id, index])), [itemIds])
  // A highlight that left the results falls back to the first match, as cmdk does.
  const activeId =
    highlightedId !== null && indexById.has(highlightedId) ? highlightedId : (itemIds[0] ?? null)
  const activeIndex = activeId === null ? -1 : (indexById.get(activeId) ?? -1)

  const virtualizer = useWindowedCommandVirtualizer({
    itemKeys: itemIds,
    scrollElement: () => listRef.current,
    estimateSize: estimateWorkspaceOptionSize,
    activeIndex,
    overscan: WORKSPACE_OPTION_OVERSCAN,
    initialRect: { width: 0, height: WORKSPACE_LIST_MAX_HEIGHT }
  })

  const setInputRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node
      setInputNode(node)
    },
    [setInputNode]
  )
  useCommandInputActiveDescendant(
    inputRef,
    activeIndex >= 0 ? `${optionIdPrefix}-${activeIndex}` : null
  )

  const handleQueryChange = (nextQuery: string): void => {
    setQuery(nextQuery)
    setHighlightedId(null)
    virtualizer.scrollToOffset(0)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const navigation = getWindowedCommandNavigation(event, itemIds, activeId)
    if (navigation) {
      event.preventDefault()
      if (navigation.targetId !== null) {
        setHighlightedId(navigation.targetId)
        virtualizer.scrollToIndex(indexById.get(navigation.targetId) ?? 0, { align: 'auto' })
      }
      return
    }
    if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event) && activeId !== null) {
      event.preventDefault()
      onSelect(activeId)
    }
  }

  return (
    <Command shouldFilter={false}>
      <CommandInput
        ref={setInputRef}
        value={query}
        onValueChange={handleQueryChange}
        onKeyDown={handleKeyDown}
        placeholder={t(
          'auto.components.automations.WorkspaceCombobox.8e9c8cc6b5',
          'Search workspaces...'
        )}
      />
      <CommandList ref={listRef} className="max-h-72">
        {filtered.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t('auto.components.automations.WorkspaceCombobox.ee5b280eba', 'No workspaces found.')}
          </div>
        ) : (
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const worktree = filtered[virtualRow.index]
              if (!worktree) {
                return null
              }
              return (
                <CommandOption
                  key={worktree.id}
                  value={worktree.id}
                  id={`${optionIdPrefix}-${virtualRow.index}`}
                  aria-posinset={virtualRow.index + 1}
                  aria-setsize={filtered.length}
                  selected={worktree.id === activeId}
                  onHighlight={() => setHighlightedId(worktree.id)}
                  onSelect={() => onSelect(worktree.id)}
                  className="absolute left-0 top-0 w-full"
                  style={{
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`
                  }}
                >
                  <Check
                    className={cn('size-4', value === worktree.id ? 'opacity-100' : 'opacity-0')}
                  />
                  <span className="truncate">{worktree.displayName}</span>
                </CommandOption>
              )
            })}
          </div>
        )}
      </CommandList>
    </Command>
  )
}

export function WorkspaceCombobox({
  worktrees,
  value,
  triggerClassName,
  onValueChange
}: {
  worktrees: Worktree[]
  value: string
  triggerClassName?: string
  onValueChange: (workspaceId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement | null>(null)
  const focusFrameRef = React.useRef<number | null>(null)
  const selected = worktrees.find((worktree) => worktree.id === value) ?? null

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

  const handleSelect = React.useCallback(
    (workspaceId: string) => {
      onValueChange(workspaceId)
      setOpen(false)
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
          className={cn('h-9 w-full justify-between px-3 text-sm font-normal', triggerClassName)}
        >
          <span className={cn('truncate', !selected && 'text-muted-foreground')}>
            {selected?.displayName ??
              t('auto.components.automations.WorkspaceCombobox.66a0cd9628', 'Select workspace')}
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
        <WorkspaceComboboxList
          worktrees={worktrees}
          value={value}
          setInputNode={setInputNode}
          onSelect={handleSelect}
        />
      </PopoverContent>
    </Popover>
  )
}

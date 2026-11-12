import React, { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandList, CommandOption } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { TooltipProvider } from '@/components/ui/tooltip'
import { FilePathCursorTooltip } from '@/components/file-path-cursor-tooltip'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import {
  getWindowedCommandNavigation,
  useCommandInputActiveDescendant
} from '@/lib/list-interaction/windowed-command-navigation'
import { useWindowedCommandVirtualizer } from '@/lib/list-interaction/use-windowed-command-virtualizer'
import type { SkillInstallWorkspaceChoice } from './skill-install-workspace-choices'

// Why: `py-2` around a 20px text line; fixed so rows never need measuring.
const CHOICE_OPTION_HEIGHT = 36
const CHOICE_OPTION_OVERSCAN = 8
// Why: matches `max-h-72`; seeds the first paint before the popover measures.
const CHOICE_LIST_MAX_HEIGHT = 288

export type SkillInstallWorkspaceComboboxProps = {
  id?: string
  value: string
  onValueChange: (value: string) => void
  choices: readonly SkillInstallWorkspaceChoice[]
  disabled?: boolean
  placeholder?: string
  triggerClassName?: string
}

/** Opening on the current choice highlights it (or nothing when it is gone); typing highlights the first match. */
type ChoiceHighlight = { kind: 'choice'; key: string } | { kind: 'none' } | { kind: 'first-match' }

// Worktree and folder ids are separate namespaces; the kind keeps option keys injective.
function choiceKey(choice: SkillInstallWorkspaceChoice): string {
  return `${choice.kind}:${choice.id}`
}

function searchChoices(
  choices: readonly SkillInstallWorkspaceChoice[],
  query: string
): readonly SkillInstallWorkspaceChoice[] {
  const trimmed = query.trim().toLowerCase()
  if (!trimmed) {
    return choices
  }
  const terms = trimmed.split(/\s+/)
  return choices.filter((choice) => {
    const kindLabel = choice.kind === 'worktree' ? 'git worktree' : 'folder'
    const searchTarget = `${choice.label} ${kindLabel}`.toLowerCase()
    return terms.every((term) => searchTarget.includes(term))
  })
}

function SkillInstallWorkspaceChoiceList({
  choices,
  value,
  query,
  highlight,
  setInputNode,
  onQueryChange,
  onHighlightChange,
  onSelect
}: {
  choices: readonly SkillInstallWorkspaceChoice[]
  value: string
  query: string
  highlight: ChoiceHighlight
  setInputNode: (node: HTMLInputElement | null) => void
  onQueryChange: (query: string) => void
  onHighlightChange: (highlight: ChoiceHighlight) => void
  onSelect: (choiceId: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const optionIdPrefix = `${useId()}option`

  const filteredChoices = useMemo(() => searchChoices(choices, query), [choices, query])
  const choiceKeys = useMemo(() => filteredChoices.map(choiceKey), [filteredChoices])
  const indexByKey = useMemo(
    () => new Map(choiceKeys.map((key, index) => [key, index])),
    [choiceKeys]
  )
  // A highlighted choice that left the results falls back to the first match, as cmdk does.
  const activeKey =
    highlight.kind === 'none'
      ? null
      : highlight.kind === 'choice' && indexByKey.has(highlight.key)
        ? highlight.key
        : (choiceKeys[0] ?? null)
  const activeIndex = activeKey === null ? -1 : (indexByKey.get(activeKey) ?? -1)

  const virtualizer = useWindowedCommandVirtualizer({
    count: filteredChoices.length,
    scrollElement: () => listRef.current,
    estimateSize: () => CHOICE_OPTION_HEIGHT,
    getItemKey: (index) => choiceKeys[index] ?? index,
    activeIndex,
    overscan: CHOICE_OPTION_OVERSCAN,
    initialRect: { width: 0, height: CHOICE_LIST_MAX_HEIGHT }
  })

  // Content mounts per open; reveal the choice it opened on once.
  const [openedOnIndex] = useState(activeIndex)
  useLayoutEffect(() => {
    if (openedOnIndex > 0) {
      virtualizer.scrollToIndex(openedOnIndex, { align: 'auto' })
    }
  }, [openedOnIndex, virtualizer])

  const setInputRef = useCallback(
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
    onQueryChange(nextQuery)
    virtualizer.scrollToOffset(0)
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    const navigation = getWindowedCommandNavigation(event, choiceKeys, activeKey)
    if (navigation) {
      event.preventDefault()
      if (navigation.targetId !== null) {
        onHighlightChange({ kind: 'choice', key: navigation.targetId })
        virtualizer.scrollToIndex(indexByKey.get(navigation.targetId) ?? 0, { align: 'auto' })
      }
      return
    }
    const activeChoice = activeIndex >= 0 ? filteredChoices[activeIndex] : undefined
    if (event.key === 'Enter' && !isImeOwnedKeyboardEvent(event) && activeChoice) {
      event.preventDefault()
      onSelect(activeChoice.id)
    }
  }

  return (
    <Command shouldFilter={false}>
      <CommandInput
        ref={setInputRef}
        placeholder={t(
          'auto.components.skills.SkillInstallWorkspaceCombobox.search',
          'Search workspaces...'
        )}
        value={query}
        onValueChange={handleQueryChange}
        onKeyDown={handleKeyDown}
      />
      <TooltipProvider>
        <CommandList ref={listRef} className="max-h-72">
          {filteredChoices.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              {t(
                'auto.components.skills.SkillInstallWorkspaceCombobox.empty',
                'No workspaces found.'
              )}
            </div>
          ) : (
            <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const choice = filteredChoices[virtualRow.index]
                if (!choice) {
                  return null
                }
                const key = choiceKey(choice)
                const isSelected = choice.id === value
                const kindLabel =
                  choice.kind === 'worktree'
                    ? t(
                        'auto.components.skills.SkillInstallTargetFields.d628c416a2',
                        'Git worktree'
                      )
                    : t('auto.components.skills.SkillInstallTargetFields.7a366323e7', 'Folder')
                const fullLabel = `${choice.label} · ${kindLabel}`

                return (
                  <CommandOption
                    key={key}
                    value={choice.id}
                    id={`${optionIdPrefix}-${virtualRow.index}`}
                    aria-posinset={virtualRow.index + 1}
                    aria-setsize={filteredChoices.length}
                    selected={key === activeKey}
                    onHighlight={() => onHighlightChange({ kind: 'choice', key })}
                    onSelect={() => onSelect(choice.id)}
                    density="flush"
                    className="absolute left-0 top-0 w-full min-w-0 cursor-pointer"
                    style={{
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`
                    }}
                  >
                    <FilePathCursorTooltip path={fullLabel}>
                      <div
                        title={fullLabel}
                        className="flex w-full min-w-0 items-center gap-2 px-3 py-2"
                      >
                        <Check
                          className={cn(
                            'size-4 shrink-0 text-foreground',
                            isSelected ? 'opacity-100' : 'opacity-0'
                          )}
                        />
                        <span className="truncate flex-1">
                          {choice.label} ·{' '}
                          <span className="text-muted-foreground">{kindLabel}</span>
                        </span>
                      </div>
                    </FilePathCursorTooltip>
                  </CommandOption>
                )
              })}
            </div>
          )}
        </CommandList>
      </TooltipProvider>
    </Command>
  )
}

export function SkillInstallWorkspaceCombobox({
  id,
  value,
  onValueChange,
  choices,
  disabled = false,
  placeholder,
  triggerClassName
}: SkillInstallWorkspaceComboboxProps): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState<ChoiceHighlight>({ kind: 'none' })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)

  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.id === value) ?? null,
    [choices, value]
  )

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
      const input = inputRef.current
      if (!input) {
        return
      }
      input.focus()
      const end = input.value.length
      input.setSelectionRange(end, end)
    })
  }, [cancelFocusFrame])

  const highlightCurrentChoice = useCallback(() => {
    setHighlight(
      selectedChoice ? { kind: 'choice', key: choiceKey(selectedChoice) } : { kind: 'none' }
    )
  }, [selectedChoice])

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        highlightCurrentChoice()
        return
      }
      cancelFocusFrame()
      setQuery('')
    },
    [cancelFocusFrame, highlightCurrentChoice]
  )

  const handleQueryChange = useCallback((nextQuery: string) => {
    setQuery(nextQuery)
    setHighlight({ kind: 'first-match' })
  }, [])

  const handleSelect = useCallback(
    (choiceId: string) => {
      onValueChange(choiceId)
      setOpen(false)
      setQuery('')
    },
    [onValueChange]
  )

  const handleTriggerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (open) {
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        highlightCurrentChoice()
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setHighlight({ kind: 'first-match' })
        setQuery(event.key)
        setOpen(true)
      }
    },
    [highlightCurrentChoice, open]
  )

  const defaultPlaceholder = t(
    'auto.components.skills.SkillInstallTargetFields.5845cfe543',
    'Choose a worktree or folder'
  )

  const selectedKindLabel =
    selectedChoice?.kind === 'worktree'
      ? t('auto.components.skills.SkillInstallTargetFields.d628c416a2', 'Git worktree')
      : t('auto.components.skills.SkillInstallTargetFields.7a366323e7', 'Folder')
  const selectedFullLabel = selectedChoice
    ? `${selectedChoice.label} · ${selectedKindLabel}`
    : undefined

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || choices.length === 0}
          onKeyDown={handleTriggerKeyDown}
          title={selectedFullLabel}
          className={cn(
            'h-9 w-full min-w-0 justify-between px-3 text-sm font-normal',
            triggerClassName
          )}
        >
          {selectedChoice ? (
            <span className="truncate">
              {selectedChoice.label} ·{' '}
              <span className="text-muted-foreground">{selectedKindLabel}</span>
            </span>
          ) : (
            <span className="truncate text-muted-foreground">
              {placeholder ?? defaultPlaceholder}
            </span>
          )}
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="popover-wheel-scroll w-[var(--radix-popover-trigger-width)] min-w-[20rem] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          focusSearchInput()
        }}
      >
        <SkillInstallWorkspaceChoiceList
          choices={choices}
          value={value}
          query={query}
          highlight={highlight}
          setInputNode={setInputNode}
          onQueryChange={handleQueryChange}
          onHighlightChange={setHighlight}
          onSelect={handleSelect}
        />
      </PopoverContent>
    </Popover>
  )
}

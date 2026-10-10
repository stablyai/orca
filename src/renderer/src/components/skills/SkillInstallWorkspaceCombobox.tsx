import React, { useCallback, useMemo, useRef, useState } from 'react'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { FilePathCursorTooltip } from '@/components/file-path-cursor-tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { SkillInstallWorkspaceChoice } from './skill-install-workspace-choices'

export type SkillInstallWorkspaceComboboxProps = {
  id?: string
  value: string
  onValueChange: (value: string) => void
  choices: readonly SkillInstallWorkspaceChoice[]
  disabled?: boolean
  placeholder?: string
  triggerClassName?: string
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

export function SkillInstallWorkspaceCombobox({
  id,
  value,
  onValueChange,
  choices,
  disabled = false,
  placeholder,
  triggerClassName
}: SkillInstallWorkspaceComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandValue, setCommandValue] = useState(value)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const focusFrameRef = useRef<number | null>(null)

  const selectedChoice = useMemo(
    () => choices.find((choice) => choice.id === value) ?? null,
    [choices, value]
  )

  const filteredChoices = useMemo(() => searchChoices(choices, query), [choices, query])

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

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen)
      if (nextOpen) {
        setCommandValue(value)
        return
      }
      cancelFocusFrame()
      setQuery('')
    },
    [cancelFocusFrame, value]
  )

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
        setCommandValue(value)
        setOpen(true)
        return
      }
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }
      if (event.key.length === 1 && /\S/.test(event.key)) {
        event.preventDefault()
        setCommandValue(value)
        setQuery(event.key)
        setOpen(true)
      }
    },
    [open, value]
  )

  const defaultPlaceholder = translate(
    'auto.components.skills.SkillInstallTargetFields.5845cfe543',
    'Choose a worktree or folder'
  )

  const selectedKindLabel =
    selectedChoice?.kind === 'worktree'
      ? translate('auto.components.skills.SkillInstallTargetFields.d628c416a2', 'Git worktree')
      : translate('auto.components.skills.SkillInstallTargetFields.7a366323e7', 'Folder')
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
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            ref={setInputNode}
            placeholder={translate(
              'auto.components.skills.SkillInstallWorkspaceCombobox.search',
              'Search workspaces...'
            )}
            value={query}
            onValueChange={setQuery}
          />
          <TooltipProvider delayDuration={200}>
            <CommandList className="max-h-72">
              <CommandEmpty>
                {translate(
                  'auto.components.skills.SkillInstallWorkspaceCombobox.empty',
                  'No workspaces found.'
                )}
              </CommandEmpty>
              {filteredChoices.map((choice) => {
                const isSelected = choice.id === value
                const kindLabel =
                  choice.kind === 'worktree'
                    ? translate(
                        'auto.components.skills.SkillInstallTargetFields.d628c416a2',
                        'Git worktree'
                      )
                    : translate(
                        'auto.components.skills.SkillInstallTargetFields.7a366323e7',
                        'Folder'
                      )
                const fullLabel = `${choice.label} · ${kindLabel}`

                return (
                  <CommandItem
                    key={`${choice.kind}:${choice.id}`}
                    value={choice.id}
                    onSelect={() => handleSelect(choice.id)}
                    className="min-w-0 !p-0 cursor-pointer"
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
                  </CommandItem>
                )
              })}
            </CommandList>
          </TooltipProvider>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

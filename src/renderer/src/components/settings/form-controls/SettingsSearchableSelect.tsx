import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '../../ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { filterSearchableSelectGroups } from './settings-form-option-filter'

export type SettingsSearchableSelectOption = {
  value: string
  label: string
  icon?: React.ReactNode
  /** Muted text after the label. */
  detail?: React.ReactNode
  keywords?: readonly string[]
  disabled?: boolean
}

export type SettingsSearchableSelectGroup = {
  key: string
  heading?: string
  options: readonly SettingsSearchableSelectOption[]
}

export type SettingsSearchableSelectAction = {
  key: string
  label: string
  icon?: React.ReactNode
  onSelect: () => void
}

type SettingsSearchableSelectProps = {
  ariaLabel: string
  value: string
  groups: readonly SettingsSearchableSelectGroup[]
  onValueChange: (value: string) => void
  searchPlaceholder: string
  emptyText?: string
  onOpenChange?: (open: boolean) => void
  /** Non-selectable rows after the options, e.g. a loading indicator. */
  status?: React.ReactNode
  /** Footer rows that run a command instead of picking a value. */
  actions?: readonly SettingsSearchableSelectAction[]
}

/** A searchable settings dropdown that matches the New Worktree dialog pickers. */
export function SettingsSearchableSelect({
  ariaLabel,
  value,
  groups,
  onValueChange,
  searchPlaceholder,
  emptyText,
  onOpenChange,
  status,
  actions
}: SettingsSearchableSelectProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [commandSelection, setCommandSelection] = useState<{
    value: string
    selectedValue: string
    query: string
  }>(() => ({ value, selectedValue: value, query: '' }))
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const selected = groups.flatMap((group) => group.options).find((option) => option.value === value)
  const visibleGroups = open ? filterSearchableSelectGroups(groups, query) : []
  const enabledOptions = visibleGroups
    .flatMap((group) => group.options)
    .filter((option) => !option.disabled)
  const selectedValueChanged = commandSelection.selectedValue !== value
  const defaultCommandValue =
    (!query.trim() || selectedValueChanged
      ? enabledOptions.find((option) => option.value === value)?.value
      : undefined) ??
    enabledOptions[0]?.value ??
    ''
  const commandValue =
    commandSelection.query === query &&
    commandSelection.selectedValue === value &&
    enabledOptions.some((option) => option.value === commandSelection.value)
      ? commandSelection.value
      : defaultCommandValue

  const handleOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      setQuery('')
      setCommandSelection({ value, selectedValue: value, query: '' })
      onOpenChange?.(next)
    },
    [onOpenChange, value]
  )

  const close = (): void => handleOpenChange(false)

  const handleTriggerKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (
      open ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey
    ) {
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      handleOpenChange(true)
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      event.preventDefault()
      handleOpenChange(true)
      setQuery(event.key)
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          onKeyDown={handleTriggerKeyDown}
          className="min-w-[220px] justify-between"
        >
          <span className="inline-flex min-w-0 flex-1 items-center gap-2">
            {selected?.icon}
            <span className="truncate">{selected?.label ?? value}</span>
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="flex max-h-(--radix-popover-content-available-height) w-[max(var(--radix-popover-trigger-width),18rem)] flex-col"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          requestAnimationFrame(() => {
            inputRef.current?.focus()
            // Why: long theme lists open scrolled to the current choice, like a native select.
            listRef.current
              ?.querySelector('[data-checked="true"]')
              ?.scrollIntoView({ block: 'nearest' })
          })
        }}
      >
        <Command
          shouldFilter={false}
          value={commandValue}
          onValueChange={(next) =>
            setCommandSelection({ value: next, selectedValue: value, query })
          }
          className="min-h-0 flex-1"
          label={ariaLabel}
        >
          <CommandInput
            ref={inputRef}
            value={query}
            onValueChange={setQuery}
            wrapperClassName="shrink-0"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
          />
          <CommandList ref={listRef} className="min-h-0 flex-1">
            {visibleGroups.length === 0 && !status ? (
              <div className="py-6 text-center text-sm text-muted-foreground">
                {emptyText ??
                  translate(
                    'auto.components.settings.SettingsSearchableSelect.noMatches',
                    'No matches.'
                  )}
              </div>
            ) : null}
            {visibleGroups.map((group) => (
              <CommandGroup key={group.key} heading={group.heading}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    data-checked={option.value === value}
                    onSelect={() => {
                      close()
                      if (option.value !== value) {
                        onValueChange(option.value)
                      }
                    }}
                  >
                    <Check
                      className={cn(
                        'size-4 shrink-0',
                        option.value === value ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                    {option.icon}
                    <span className="min-w-0 truncate">{option.label}</span>
                    {option.detail ? (
                      <span className="ml-auto flex shrink-0 items-center text-xs text-muted-foreground">
                        {option.detail}
                      </span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
            {status}
          </CommandList>
        </Command>
        {actions && actions.length > 0 ? (
          <div className="shrink-0 border-t border-border">
            {actions.map((action) => (
              <Button
                key={action.key}
                type="button"
                variant="ghost"
                size="menu"
                className="w-full justify-start"
                onClick={() => {
                  close()
                  action.onSelect()
                }}
              >
                <span className="flex items-center gap-2 text-muted-foreground">
                  {action.icon}
                  {action.label}
                </span>
              </Button>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

import type React from 'react'
import { useCallback, useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '../../ui/button'
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '../../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import { cn } from '@/lib/utils'
import { useTranslate } from '@/i18n/use-translate'
import { filterSearchableSelectGroups } from './settings-form-option-filter'

export type SettingsSearchableSelectOption = {
  value: string
  label: string
  icon?: React.ReactNode
  /** Muted text after the label. */
  detail?: React.ReactNode
  keywords?: readonly string[]
  disabled?: boolean
  action?: Omit<SettingsSearchableSelectAction, 'key'>
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
  compact?: boolean
  /** Size the trigger to its value like the plain settings selects, instead of a fixed 220px. */
  fitValue?: boolean
  emptyText?: string
  open?: boolean
  disabled?: boolean
  onOpenChange?: (open: boolean) => void
  query?: string
  onQueryChange?: (query: string) => void
  /** Reapplying a theme can clear its custom color overrides. */
  allowReselect?: boolean
  /** Non-selectable rows after the options, e.g. a loading indicator. */
  status?: React.ReactNode
  /** Footer rows that run a command instead of picking a value. */
  actions?: readonly SettingsSearchableSelectAction[]
}

/** A searchable settings dropdown that matches the New Worktree dialog pickers. */
export function SettingsSearchableSelect(props: SettingsSearchableSelectProps): React.JSX.Element {
  return (
    <SettingsSearchableSelectControl key={props.disabled ? 'disabled' : 'enabled'} {...props} />
  )
}

function SettingsSearchableSelectControl({
  ariaLabel,
  value,
  groups,
  onValueChange,
  searchPlaceholder,
  emptyText,
  compact = false,
  fitValue = false,
  open: controlledOpen,
  disabled = false,
  onOpenChange,
  query: controlledQuery,
  onQueryChange,
  allowReselect = false,
  status,
  actions
}: SettingsSearchableSelectProps): React.JSX.Element {
  const t = useTranslate()
  const [internalOpen, setOpen] = useState(false)
  const [internalQuery, setInternalQuery] = useState('')
  const open = controlledOpen ?? internalOpen
  const query = controlledQuery ?? internalQuery
  const setQuery = useCallback(
    (next: string) => {
      setInternalQuery(next)
      onQueryChange?.(next)
    },
    [onQueryChange]
  )
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
      const nextOpen = next && !disabled
      setOpen(nextOpen)
      setQuery('')
      setCommandSelection({ value, selectedValue: value, query: '' })
      onOpenChange?.(nextOpen)
    },
    [disabled, onOpenChange, setQuery, value]
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
    <Popover open={open && !disabled} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={compact ? 'ghost' : 'outline'}
          size="sm"
          role="combobox"
          aria-expanded={open && !disabled}
          aria-label={ariaLabel}
          disabled={disabled}
          onKeyDown={handleTriggerKeyDown}
          className={
            compact
              ? 'w-auto min-w-0 max-w-56 justify-between'
              : fitValue
                ? 'min-w-32 justify-between'
                : 'min-w-[220px] justify-between'
          }
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
          label={searchPlaceholder}
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
                  t('auto.components.settings.SettingsSearchableSelect.noMatches', 'No matches.')}
              </div>
            ) : null}
            {visibleGroups.map((group) => (
              <CommandGroup key={group.key} heading={group.heading}>
                {group.options.map((option) => (
                  <div key={option.value} className="flex items-center gap-1">
                    <CommandItem
                      value={option.value}
                      disabled={option.disabled}
                      data-checked={option.value === value}
                      className="min-w-0 flex-1"
                      onSelect={() => {
                        close()
                        if (allowReselect || option.value !== value) {
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
                    {option.action ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            className="mr-1 shrink-0"
                            aria-label={option.action.label}
                            disabled={option.disabled}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.stopPropagation()
                              }
                            }}
                            onClick={() => {
                              option.action?.onSelect()
                              inputRef.current?.focus()
                            }}
                          >
                            {option.action.icon}
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top" sideOffset={4}>
                          {option.action.label}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </div>
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

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Plus, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import { Button } from '../ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import {
  CustomAddressDialog,
  type CustomAddressDialogCopy,
  type CustomAddressValidator
} from './CustomAddressDialog'

export type AddressOption = {
  value: string
  label: string
}

const EMPTY_ADDRESS_OPTIONS: readonly AddressOption[] = []

type AddressPickerItemProps = {
  option: AddressOption
  selected: boolean
  commandValue: string
  onSelect: () => void
  onRemove?: () => void
  removeLabel?: string
}

function AddressPickerItem({
  option,
  selected,
  commandValue,
  onSelect,
  onRemove,
  removeLabel
}: AddressPickerItemProps): React.JSX.Element {
  return (
    <div className="group relative">
      <CommandItem
        value={commandValue}
        onSelect={onSelect}
        data-current={selected ? 'true' : undefined}
        className={cn('peer min-w-0', onRemove && 'pr-8', selected && 'bg-accent')}
      >
        <Check className={cn('size-3.5 shrink-0', !selected && 'invisible')} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{option.label}</span>
      </CommandItem>
      {onRemove ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={removeLabel}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.stopPropagation()
                }
              }}
              onClick={(event) => {
                event.stopPropagation()
                onRemove()
              }}
              className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 peer-data-[selected=true]:opacity-100 hover:text-destructive focus-visible:opacity-100"
            >
              <X aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {removeLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}

export type AddressPickerProps = {
  options: readonly AddressOption[]
  customOptions?: readonly AddressOption[]
  value: string | undefined
  valueIsCustom?: boolean
  onValueChange: (value: string) => void
  onCustomValueChange?: (value: string) => void
  onCustomRemove?: (value: string) => void
  beforeCustomConfirm?: (value: string) => boolean | Promise<boolean>
  formatCustomLabel: (value: string) => string
  addCustomLabel: string
  customSectionLabel?: string
  removeCustomLabel?: (value: string) => string
  customDialogCopy: CustomAddressDialogCopy
  validateCustom: CustomAddressValidator
  customInputId: string
  placeholder: string
  triggerAriaLabel: string
  disabled?: boolean
  className?: string
  id?: string
}

// Why: removable saved rows have two actions, which cannot be represented by a Select option.
export function AddressPicker({
  options,
  customOptions = EMPTY_ADDRESS_OPTIONS,
  value,
  valueIsCustom,
  onValueChange,
  onCustomValueChange,
  onCustomRemove,
  beforeCustomConfirm,
  formatCustomLabel,
  addCustomLabel,
  customSectionLabel,
  removeCustomLabel,
  customDialogCopy,
  validateCustom,
  customInputId,
  placeholder,
  triggerAriaLabel,
  disabled = false,
  className,
  id
}: AddressPickerProps): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [commandValue, setCommandValue] = useState('')
  const [listId, setListId] = useState<string>()
  const listRef = useRef<HTMLDivElement>(null)
  const restoreFocusAfterRemovalRef = useRef(false)
  const typeaheadRef = useRef({ query: '', updatedAt: 0 })
  const handleListRef = useCallback((node: HTMLDivElement | null) => {
    listRef.current = node
    setListId(node?.id)
  }, [])
  const isCustomSelection =
    value !== undefined &&
    value !== '' &&
    (valueIsCustom ?? !options.some((option) => option.value === value))
  const displayedCustomOptions = useMemo(() => {
    if (
      !isCustomSelection ||
      value === undefined ||
      customOptions.some((option) => option.value === value)
    ) {
      return customOptions
    }
    return [...customOptions, { value, label: formatCustomLabel(value) }]
  }, [customOptions, formatCustomLabel, isCustomSelection, value])
  const selectedOption =
    (isCustomSelection
      ? displayedCustomOptions.find((option) => option.value === value)
      : options.find((option) => option.value === value)) ??
    displayedCustomOptions.find((option) => option.value === value)
  const selectedCommandValue = value ? `${isCustomSelection ? 'custom' : 'detected'}:${value}` : ''
  const customValueChange = onCustomValueChange ?? onValueChange
  const firstCommandValue =
    selectedCommandValue ||
    (options[0]
      ? `detected:${options[0].value}`
      : displayedCustomOptions[0]
        ? `custom:${displayedCustomOptions[0].value}`
        : 'add-custom-address')

  useEffect(() => {
    if (!pickerOpen) {
      return
    }
    const commandValueExists =
      commandValue === 'add-custom-address' ||
      options.some((option) => commandValue === `detected:${option.value}`) ||
      displayedCustomOptions.some((option) => commandValue === `custom:${option.value}`)
    if (!commandValueExists) {
      setCommandValue(firstCommandValue)
    }
  }, [commandValue, displayedCustomOptions, firstCommandValue, options, pickerOpen])

  useEffect(() => {
    if (!pickerOpen || !restoreFocusAfterRemovalRef.current) {
      return
    }
    restoreFocusAfterRemovalRef.current = false
    listRef.current?.focus()
  }, [displayedCustomOptions, pickerOpen])

  useEffect(() => {
    if (!pickerOpen) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      const list = listRef.current
      const activeOption = list?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')
      if (list && activeOption?.id) {
        list.setAttribute('aria-activedescendant', activeOption.id)
      }
    })
    return () => window.cancelAnimationFrame(frame)
  }, [commandValue, displayedCustomOptions, options, pickerOpen])

  const handlePickerOpenChange = (nextOpen: boolean): void => {
    typeaheadRef.current = { query: '', updatedAt: 0 }
    if (nextOpen) {
      setCommandValue(firstCommandValue)
    }
    setPickerOpen(nextOpen)
  }

  const handleCommandKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === ' ') {
      event.preventDefault()
      listRef.current?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]')?.click()
      return
    }
    if (
      event.key.length !== 1 ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      isImeCompositionKeyDown(event)
    ) {
      return
    }
    event.preventDefault()
    const now = Date.now()
    const previous = typeaheadRef.current
    const query = now - previous.updatedAt > 700 ? event.key : previous.query + event.key
    typeaheadRef.current = { query, updatedAt: now }
    const repeatedKey = [...query].every((character) => character === query[0])
    const prefix = (repeatedKey ? event.key : query).toLocaleLowerCase()
    const items = [
      ...options.map((option) => ({ command: `detected:${option.value}`, label: option.label })),
      ...displayedCustomOptions.map((option) => ({
        command: `custom:${option.value}`,
        label: option.label
      })),
      { command: 'add-custom-address', label: addCustomLabel }
    ]
    const currentIndex = items.findIndex((item) => item.command === commandValue)
    const nextItem = [...items.slice(currentIndex + 1), ...items.slice(0, currentIndex + 1)].find(
      (item) => item.label.toLocaleLowerCase().startsWith(prefix)
    )
    if (nextItem) {
      setCommandValue(nextItem.command)
    }
  }

  const selectValue = (next: string, custom: boolean): void => {
    setPickerOpen(false)
    if (custom) {
      customValueChange(next)
    } else {
      onValueChange(next)
    }
  }

  const handleCustomConfirm = async (next: string): Promise<boolean> => {
    if (beforeCustomConfirm && !(await beforeCustomConfirm(next))) {
      return false
    }
    customValueChange(next)
    return true
  }

  return (
    <>
      <Popover open={pickerOpen} onOpenChange={handlePickerOpenChange}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-controls={pickerOpen ? listId : undefined}
            aria-expanded={pickerOpen}
            aria-label={triggerAriaLabel}
            disabled={disabled}
            className={cn('w-fit min-w-0 justify-between px-3 font-normal', className)}
          >
            <span className="min-w-0 flex-1 truncate text-left">
              {selectedOption?.label ?? placeholder}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={4}
          className="w-[var(--radix-popover-trigger-width)] min-w-[14rem] p-0"
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            listRef.current?.focus()
          }}
        >
          <Command
            shouldFilter={false}
            loop
            value={commandValue}
            onValueChange={setCommandValue}
            onKeyDown={handleCommandKeyDown}
          >
            <CommandList ref={handleListRef} label={triggerAriaLabel} className="max-h-72 py-1">
              {options.length > 0 ? (
                <CommandGroup>
                  {options.map((option) => (
                    <AddressPickerItem
                      key={option.value}
                      option={option}
                      selected={!isCustomSelection && option.value === value}
                      commandValue={`detected:${option.value}`}
                      onSelect={() => selectValue(option.value, false)}
                    />
                  ))}
                </CommandGroup>
              ) : null}
              {displayedCustomOptions.length > 0 ? (
                <CommandGroup
                  heading={customSectionLabel}
                  className={cn(options.length > 0 && 'border-t border-border pt-1')}
                >
                  {displayedCustomOptions.map((option) => (
                    <AddressPickerItem
                      key={option.value}
                      option={option}
                      selected={isCustomSelection && option.value === value}
                      commandValue={`custom:${option.value}`}
                      onSelect={() => selectValue(option.value, true)}
                      onRemove={
                        onCustomRemove
                          ? () => {
                              restoreFocusAfterRemovalRef.current = true
                              onCustomRemove(option.value)
                            }
                          : undefined
                      }
                      removeLabel={removeCustomLabel?.(option.value)}
                    />
                  ))}
                </CommandGroup>
              ) : null}
              <CommandGroup
                className={cn(
                  (options.length > 0 || displayedCustomOptions.length > 0) &&
                    'border-t border-border pt-1'
                )}
              >
                <CommandItem
                  value="add-custom-address"
                  onSelect={() => {
                    setPickerOpen(false)
                    setDialogOpen(true)
                  }}
                  className="text-muted-foreground data-[selected=true]:text-foreground"
                >
                  <Plus className="size-3.5" aria-hidden />
                  {addCustomLabel}
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <CustomAddressDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialValue={isCustomSelection ? value : undefined}
        validate={validateCustom}
        copy={customDialogCopy}
        inputId={customInputId}
        onConfirm={handleCustomConfirm}
      />
    </>
  )
}

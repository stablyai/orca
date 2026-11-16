import type React from 'react'
import { useRef, useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from './ui/command'

export type WorkItemScopeOption<T> = {
  key: string
  value: T
  label: string
  searchText: string
  description?: string
}

export function WorkItemScopePicker<T>({
  options,
  selectedKey,
  selectedLabel,
  onChange,
  label,
  allLabel,
  searchPlaceholder,
  emptyLabel,
  disabled,
  size = 'default',
  returnFocusRef
}: {
  options: readonly WorkItemScopeOption<T>[]
  selectedKey: string | null
  selectedLabel?: string
  onChange: (value: T | null) => void
  label: string
  allLabel: string
  searchPlaceholder: string
  emptyLabel: string
  disabled?: boolean
  size?: 'default' | 'xs'
  returnFocusRef?: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const returnFocusOnCloseRef = useRef(false)
  const select = (value: T | null) => {
    returnFocusOnCloseRef.current = true
    onChange(value)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={size}
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn('justify-between', size === 'xs' ? 'min-w-0 max-w-full' : 'w-full')}
        >
          <span className="truncate">{selectedLabel ?? allLabel}</span>
          <ChevronsUpDown
            className={cn('shrink-0', size === 'xs' ? 'size-3 opacity-60' : 'size-4')}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="z-[70] w-64"
        onKeyDown={(event) => event.stopPropagation()}
        onEscapeKeyDown={() => {
          returnFocusOnCloseRef.current = true
        }}
        onCloseAutoFocus={(event) => {
          const shouldReturnFocus = returnFocusOnCloseRef.current
          returnFocusOnCloseRef.current = false
          if (!shouldReturnFocus || !returnFocusRef?.current) {
            return
          }
          event.preventDefault()
          returnFocusRef.current.focus({ preventScroll: true })
        }}
      >
        <Command density={size === 'xs' ? 'menu' : 'default'}>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem selection="palette" value={allLabel} onSelect={() => select(null)}>
                <span className="flex-1">{allLabel}</span>
                {selectedKey === null ? <Check className="size-4" /> : null}
              </CommandItem>
              {options.map((option) => (
                <CommandItem
                  key={option.key}
                  selection="palette"
                  value={option.searchText}
                  onSelect={() => select(option.value)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description ? (
                      <span className="block truncate text-xs text-muted-foreground">
                        {option.description}
                      </span>
                    ) : null}
                  </span>
                  {selectedKey === option.key ? <Check className="size-4" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

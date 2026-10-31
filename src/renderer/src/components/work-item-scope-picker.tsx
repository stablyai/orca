import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from './ui/button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Command, CommandInput, CommandList, CommandEmpty, CommandItem } from './ui/command'

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
  disabled
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
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const select = (value: T | null) => {
    onChange(value)
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-label={label}
          aria-expanded={open}
          disabled={disabled}
          className="w-full justify-between"
        >
          <span className="truncate">{selectedLabel ?? allLabel}</span>
          <ChevronsUpDown className="size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandItem value={allLabel} onSelect={() => select(null)}>
              <span className="flex-1">{allLabel}</span>
              {selectedKey === null ? <Check className="size-4" /> : null}
            </CommandItem>
            {options.map((option) => (
              <CommandItem
                key={option.key}
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
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

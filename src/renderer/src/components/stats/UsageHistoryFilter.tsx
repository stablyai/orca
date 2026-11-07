import { useState } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { translate } from '@/i18n/i18n'

export function UsageHistoryFilter({
  label,
  value,
  allLabel,
  options,
  onChange
}: {
  label: string
  value: string | null
  allLabel: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string | null) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selectedLabel =
    value === null ? allLabel : (options.find((option) => option.value === value)?.label ?? value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={label}
          className="min-w-0 justify-between"
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 max-w-[calc(100vw-2rem)]" align="start">
        <Command>
          <CommandInput
            placeholder={translate('stats.usage.filter.search', 'Search {{filter}}…', {
              filter: label
            })}
            aria-label={label}
          />
          <CommandList>
            <CommandEmpty>{translate('stats.usage.filter.noMatches', 'No matches')}</CommandEmpty>
            <CommandGroup heading={label}>
              {[{ value: null, label: allLabel }, ...options].map((option) => (
                <CommandItem
                  key={option.value ?? '__all'}
                  value={`${option.value ?? '__all'} ${option.label}`}
                  onSelect={() => {
                    onChange(option.value)
                    setOpen(false)
                  }}
                >
                  <Check
                    className={`size-3.5 ${option.value === value ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <span className="break-all">{option.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

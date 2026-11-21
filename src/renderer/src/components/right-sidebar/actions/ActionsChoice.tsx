import { useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem
} from '@/components/ui/command'
import { translate } from '@/i18n/i18n'
/** Offer keyboard-searchable choices and close the popover after forwarding the selected stable value. */
export function ActionsChoice({
  value,
  options,
  label,
  disabled,
  onChange
}: {
  value: string
  options: { value: string; label: string }[]
  label: string
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" disabled={disabled} aria-label={label}>
          <span className="min-w-0 flex-1 truncate">
            {options.find((entry) => entry.value === value)?.label ?? label}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start">
        <Command>
          <CommandInput placeholder={label} />
          <CommandList>
            <CommandEmpty>{translate('actions.noOptions', 'No matches.')}</CommandEmpty>
            {options.map((entry) => (
              <CommandItem
                key={entry.value}
                value={`${entry.value} ${entry.label}`}
                onSelect={() => {
                  onChange(entry.value)
                  setOpen(false)
                }}
              >
                {entry.label}
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

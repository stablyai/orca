import React from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'

import type { OdooTicketFilterId } from '@/components/odoo-ticket-filter-select'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

function triggerLabel(selected: readonly string[], allLabel: string): string {
  if (selected.length === 0) {
    return allLabel
  }
  const [first] = selected
  return selected.length === 1
    ? (first ?? allLabel)
    : translate(
        'auto.components.odoo.ticket.filter.multi.select.93e80c55c9',
        '{{value0}} +{{value1}}',
        {
          value0: first,
          value1: selected.length - 1
        }
      )
}

/**
 * Multi-value facet dropdown. Shares the toolbar's single open slot with the
 * single-value selects so opening one still closes the others.
 */
export function OdooTicketFilterMultiSelect({
  id,
  openFilter,
  onOpenFilterChange,
  options,
  selected,
  onSelectedChange,
  allLabel,
  triggerClassName
}: {
  id: string
  openFilter: OdooTicketFilterId
  onOpenFilterChange: (next: OdooTicketFilterId) => void
  options: readonly string[]
  selected: readonly string[]
  onSelectedChange: (next: string[]) => void
  allLabel: string
  triggerClassName?: string
}): React.JSX.Element {
  const toggle = (option: string): void => {
    onSelectedChange(
      selected.includes(option)
        ? selected.filter((entry) => entry !== option)
        : [...selected, option]
    )
  }

  return (
    <Popover open={openFilter === id} onOpenChange={(next) => onOpenFilterChange(next ? id : null)}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={openFilter === id}
          className={cn('h-7 justify-between gap-1 px-2 text-xs font-normal', triggerClassName)}
        >
          <span className="min-w-0 truncate">{triggerLabel(selected, allLabel)}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <Command shouldFilter={false}>
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.odoo.ticket.filter.multi.select.3a02612aab',
                'Nothing to filter on.'
              )}
            </CommandEmpty>
            <CommandItem
              value="__all__"
              onSelect={() => onSelectedChange([])}
              className="items-center gap-2 px-2 py-1.5 text-xs"
            >
              <Check
                className={cn(
                  'size-3 text-muted-foreground',
                  selected.length === 0 ? 'opacity-70' : 'opacity-0'
                )}
              />
              <span className="min-w-0 truncate">{allLabel}</span>
            </CommandItem>
            {options.map((option) => (
              <CommandItem
                key={option}
                value={option}
                onSelect={() => toggle(option)}
                className="items-center gap-2 px-2 py-1.5 text-xs"
              >
                <Check
                  className={cn(
                    'size-3 text-muted-foreground',
                    selected.includes(option) ? 'opacity-70' : 'opacity-0'
                  )}
                />
                <span className="min-w-0 truncate">{option}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

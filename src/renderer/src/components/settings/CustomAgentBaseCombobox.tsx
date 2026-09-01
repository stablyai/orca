import { useState } from 'react'
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
import { AgentIcon, type AgentCatalogEntry } from '@/lib/agent-catalog'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BuiltInTuiAgent } from '../../../../shared/types'

type CustomAgentBaseComboboxProps = {
  options: readonly AgentCatalogEntry[]
  value: BuiltInTuiAgent
  onChange: (base: BuiltInTuiAgent) => void
  id?: string
}

/** Base-harness picker for the create dialog. The base is immutable after
 *  creation, so this control only appears in "new" mode; edit/duplicate render a
 *  read-only tile instead. */
export function CustomAgentBaseCombobox({
  options,
  value,
  onChange,
  id
}: CustomAgentBaseComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const selected = options.find((option) => option.id === value)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-9 w-full justify-between px-3 font-normal"
        >
          <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
            {selected ? <AgentIcon agent={selected.id} /> : null}
            <span className="truncate">
              {selected
                ? selected.label
                : translate(
                    'auto.components.settings.CustomAgentEditorDialog.baseChoosePlaceholder',
                    'Choose a base harness'
                  )}
            </span>
          </span>
          <ChevronsUpDown className="size-3.5 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-[16rem] p-0"
      >
        <Command>
          <CommandInput
            placeholder={translate(
              'auto.components.settings.CustomAgentEditorDialog.baseSearchPlaceholder',
              'Search harnesses...'
            )}
          />
          <CommandList>
            <CommandEmpty>
              {translate(
                'auto.components.settings.CustomAgentEditorDialog.baseNoMatch',
                'No harnesses match your search.'
              )}
            </CommandEmpty>
            {options.map((option) => (
              <CommandItem
                key={option.id}
                value={option.label}
                onSelect={() => {
                  onChange(option.id as BuiltInTuiAgent)
                  setOpen(false)
                }}
                className="items-center gap-2 px-3 py-1.5"
              >
                <Check
                  className={cn('size-4', option.id === value ? 'opacity-100' : 'opacity-0')}
                />
                <span className="inline-flex min-w-0 flex-1 items-center gap-1.5">
                  <AgentIcon agent={option.id} />
                  <span className="truncate">{option.label}</span>
                </span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

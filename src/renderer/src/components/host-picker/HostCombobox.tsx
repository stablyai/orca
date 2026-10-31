import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { boundHostList } from './bounded-host-list'
import { HostListOverflowNote } from './HostListOverflowNote'
import { noHostsMatchLabel, searchHostsLabel } from './host-picker-copy'

export type HostComboboxOption = {
  id: string
  /** What search matches and the trigger shows. */
  label: string
  /** Secondary text after the label, such as "SSH" or "disconnected". */
  detail?: string
  /** Replaces label and detail in the result row. */
  content?: React.ReactNode
  /** Heading the row is listed under; rows keep their input order within it. */
  group?: string
  disabled?: boolean
}

function groupOptions(
  options: readonly HostComboboxOption[]
): { heading: string | undefined; options: HostComboboxOption[] }[] {
  const groups = new Map<string | undefined, HostComboboxOption[]>()
  for (const option of options) {
    const group = groups.get(option.group) ?? []
    group.push(option)
    groups.set(option.group, group)
  }
  return [...groups].map(([heading, grouped]) => ({ heading, options: grouped }))
}

/** Mount only a bounded searchable list on open; eager Select items can exhaust memory on large host catalogs. */
export function HostCombobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  size = 'default',
  notifyOnReselect = false,
  className,
  disabled
}: {
  id?: string
  value: string
  onChange: (id: string) => void
  options: readonly HostComboboxOption[]
  placeholder?: string
  ariaLabel?: string
  size?: 'xs' | 'sm' | 'default'
  className?: string
  disabled?: boolean
  notifyOnReselect?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const selected = options.find((option) => option.id === value)
  // Why pinned only before typing: the current choice stays visible without crowding results.
  const { shown, hiddenCount } = open
    ? boundHostList(options, { query, pinnedIds: query === '' ? new Set([value]) : undefined })
    : { shown: [], hiddenCount: 0 }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          size={size}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn('w-full justify-between', className)}
        >
          <span className="min-w-0 truncate">
            {selected ? selected.label : (placeholder ?? '')}
          </span>
          <ChevronDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(20rem,calc(100vw-1rem))]">
        <Command shouldFilter={false} density="menu" label={searchHostsLabel()}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={searchHostsLabel()}
            aria-label={searchHostsLabel()}
          />
          <CommandList>
            <CommandEmpty>{noHostsMatchLabel()}</CommandEmpty>
            {groupOptions(shown).map((group) => (
              <CommandGroup key={group.heading ?? ''} heading={group.heading}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    selection="palette"
                    disabled={option.disabled}
                    onSelect={() => {
                      setOpen(false)
                      if (option.id !== value || notifyOnReselect) {
                        onChange(option.id)
                      }
                    }}
                  >
                    {option.content ?? (
                      <>
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {option.detail ? (
                          <span className="shrink-0 text-muted-foreground">{option.detail}</span>
                        ) : null}
                      </>
                    )}
                    {option.id === value ? <Check className="size-3.5 shrink-0" /> : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
          <HostListOverflowNote hiddenCount={hiddenCount} />
        </Command>
      </PopoverContent>
    </Popover>
  )
}

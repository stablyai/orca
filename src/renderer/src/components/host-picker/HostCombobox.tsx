import { useRef, useState } from 'react'
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
import { cn } from '@/lib/class-names'
import { boundHostList } from './bounded-host-list'
import { HostListOverflowNote } from './HostListOverflowNote'
import { noHostsMatchLabel, searchHostsLabel } from './host-picker-copy'
import { useTranslate } from '@/i18n/use-translate'

export type HostComboboxOption = {
  id: string
  /** What search matches and the trigger shows. */
  label: string
  /** Secondary text after the label, such as "SSH" or "disconnected". */
  detail?: string
  /** Replaces label and detail in the result row. */
  content?: React.ReactNode
  /** Replaces label in the trigger. */
  triggerContent?: React.ReactNode
  /** Heading the row is listed under; headings keep the input's order, even while search ranks rows. */
  group?: string
  disabled?: boolean
  /** Hover text, also read with the label by screen readers. */
  description?: string
  /** Runs instead of picking the row. */
  onSelect?: () => void
  /** With `onSelect`, the list stays open. */
  keepOpen?: boolean
}

function groupOptions(
  options: readonly HostComboboxOption[],
  order: readonly HostComboboxOption[]
): { heading: string | undefined; options: HostComboboxOption[] }[] {
  const groups = new Map<string | undefined, HostComboboxOption[]>()
  for (const option of order) {
    groups.set(option.group, [])
  }
  for (const option of options) {
    groups.get(option.group)?.push(option)
  }
  return [...groups]
    .filter(([, grouped]) => grouped.length > 0)
    .map(([heading, grouped]) => ({ heading, options: grouped }))
}

/** Mount only a bounded searchable list on open; eager Select items can exhaust memory on large host catalogs. */
export function HostCombobox({
  id,
  value,
  onChange,
  options,
  placeholder,
  searchPlaceholder,
  searchFrom = 0,
  ariaLabel,
  inline,
  size = 'default',
  notifyOnReselect = false,
  className,
  disabled,
  reserveCheck = false,
  onOpenChange
}: {
  id?: string
  value: string
  onChange: (id: string) => void
  options: readonly HostComboboxOption[]
  placeholder?: string
  /** Defaults to "Search hosts…". */
  searchPlaceholder?: string
  /** Search shows only from this many rows. */
  searchFrom?: number
  ariaLabel?: string
  inline?: boolean
  size?: 'xs' | 'sm' | 'default'
  className?: string
  disabled?: boolean
  notifyOnReselect?: boolean
  /** Rows keep the check's slot so right-aligned content ends on one edge; action rows (`onSelect`)
   *  never hold the check, so their content runs to the row's edge where the check sits. */
  reserveCheck?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [boundary, setBoundary] = useState<HTMLElement>()
  const commandRef = useRef<HTMLDivElement>(null)
  const selected = options.find((option) => option.id === value)
  const searchable = options.length >= searchFrom
  const searchLabel = searchPlaceholder ?? searchHostsLabel(t)
  // Why pinned only before typing: the current choice stays visible without crowding results.
  const { shown, hiddenCount } = open
    ? boundHostList(options, { query, pinnedIds: query === '' ? new Set([value]) : undefined })
    : { shown: [], hiddenCount: 0 }
  const changeOpen = (next: boolean): void => {
    setOpen(next)
    if (next) {
      setQuery('')
      if (inline) {
        setBoundary(
          triggerRef.current?.closest<HTMLElement>('[data-slot="dialog-content"]') ?? undefined
        )
      }
    }
    onOpenChange?.(next)
  }

  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          id={id}
          type="button"
          variant="outline"
          size={inline ? 'xs' : size}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(inline ? 'min-w-0 shrink' : 'w-full justify-between', className)}
        >
          {selected?.triggerContent ?? (
            <span className="min-w-0 truncate">
              {selected ? selected.label : (placeholder ?? '')}
            </span>
          )}
          <ChevronDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side={inline ? 'top' : undefined}
        collisionBoundary={boundary}
        collisionPadding={inline ? 8 : undefined}
        className={cn(
          'w-[min(20rem,calc(100vw-1rem))] max-w-(--radix-popover-content-available-width)',
          inline && 'flex flex-col'
        )}
        onOpenAutoFocus={(event) => {
          // Without a search field, the list itself takes the arrow keys.
          if (!searchable) {
            event.preventDefault()
            commandRef.current?.focus()
          }
        }}
      >
        <Command
          ref={commandRef}
          tabIndex={-1}
          shouldFilter={false}
          density="menu"
          className={inline ? 'min-h-0' : undefined}
          label={searchLabel}
        >
          {searchable ? (
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={searchLabel}
              aria-label={searchLabel}
            />
          ) : null}
          <CommandList>
            <CommandEmpty>{noHostsMatchLabel(t)}</CommandEmpty>
            {groupOptions(shown, options).map((group) => (
              <CommandGroup key={group.heading ?? ''} heading={group.heading}>
                {group.options.map((option) => (
                  <CommandItem
                    key={option.id}
                    value={option.id}
                    selection="palette"
                    disabled={option.disabled}
                    title={option.description}
                    aria-label={
                      option.description ? `${option.label}: ${option.description}` : undefined
                    }
                    onSelect={() => {
                      if (option.onSelect) {
                        if (!option.keepOpen) {
                          changeOpen(false)
                        }
                        option.onSelect()
                        return
                      }
                      changeOpen(false)
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
                    {option.id === value || (reserveCheck && !option.onSelect) ? (
                      <Check
                        aria-hidden
                        className={cn('size-3.5 shrink-0', option.id !== value && 'invisible')}
                      />
                    ) : null}
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

import { useMemo, useState } from 'react'
import { Check, ChevronDown, LoaderCircle, TriangleAlert } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  PluginTaskFacet,
  PluginTaskFacetOption
} from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceFacetOptions } from '@/store/slices/plugin-task-sources-slice-contract'
import { describePluginTaskFacetSelection, filterPluginTaskFacetOptions } from './facet-selection'

/** One identity across renders, so an unsettled facet does not invalidate the
 *  memoized filter every time the bar re-renders. */
const NO_OPTIONS: PluginTaskFacetOption[] = []

export function TaskPagePluginSourceFacetPicker({
  facet,
  options,
  selectedOptionIds,
  onToggleOption,
  onClear
}: {
  facet: PluginTaskFacet
  options: PluginTaskSourceFacetOptions
  selectedOptionIds: string[]
  onToggleOption: (optionId: string) => void
  onClear: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [commandValue, setCommandValue] = useState('')
  const ready = options.status === 'ready' ? options.options : NO_OPTIONS
  const visibleOptions = useMemo(() => filterPluginTaskFacetOptions(ready, search), [ready, search])
  const selected = useMemo(() => new Set(selectedOptionIds), [selectedOptionIds])

  // A failed option fetch must not read as "nothing matches this facet", so the
  // outage takes the control's place. `status`, not `alert`: the item load
  // reports the same outage as the page's one assertive banner.
  if (options.status === 'failed') {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            role="status"
            className="flex h-8 min-w-0 shrink-0 items-center gap-1.5 rounded-md border border-destructive/50 px-2 text-xs text-destructive"
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">
              {translate(
                'auto.components.TaskPage.pluginTaskSourceFacetFailed',
                '{{value0}} unavailable',
                { value0: facet.label }
              )}
            </span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {options.error.message}
        </TooltipContent>
      </Tooltip>
    )
  }

  if (options.status === 'loading') {
    return (
      <Button type="button" variant="outline" size="sm" disabled aria-label={facet.label}>
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
        <span className="min-w-0 truncate">
          {translate('auto.components.TaskPage.pluginTaskSourceFacetLoading', 'Loading...')}
        </span>
      </Button>
    )
  }

  const active = selectedOptionIds.length > 0
  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) {
          setSearch('')
          setCommandValue('')
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant={active ? 'secondary' : 'outline'}
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-label={facet.label}
          className="max-w-[220px] shrink-0 justify-between"
        >
          <span className="min-w-0 truncate">
            {describePluginTaskFacetSelection(facet, ready, selectedOptionIds)}
          </span>
          <ChevronDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(320px,calc(100vw-1rem))] min-w-[var(--radix-popover-trigger-width)]"
      >
        <Command shouldFilter={false} value={commandValue} onValueChange={setCommandValue}>
          <CommandInput
            autoFocus
            placeholder={translate(
              'auto.components.TaskPage.pluginTaskSourceFacetOptionSearch',
              'Search options...'
            )}
            value={search}
            onValueChange={setSearch}
          />
          {active ? (
            <div className="border-b border-border py-1">
              <CommandItem value="__clear-facet__" onSelect={onClear}>
                <span>
                  {translate('auto.components.TaskPage.pluginTaskSourceFacetClear', 'Clear')}
                </span>
              </CommandItem>
            </div>
          ) : null}
          <CommandList>
            {ready.length === 0 ? (
              <div className="px-3 py-5 text-xs text-muted-foreground">
                {translate(
                  'auto.components.TaskPage.pluginTaskSourceFacetEmpty',
                  'No options for this selection.'
                )}
              </div>
            ) : null}
            {ready.length > 0 && visibleOptions.length === 0 ? (
              <div className="px-3 py-5 text-xs text-muted-foreground">
                {translate(
                  'auto.components.TaskPage.pluginTaskSourceFacetNoMatch',
                  'No options match your search.'
                )}
              </div>
            ) : null}
            {visibleOptions.map((option) => (
              <CommandItem
                key={option.id}
                value={option.id}
                onSelect={() => onToggleOption(option.id)}
              >
                <Check
                  className={cn(
                    'size-3 text-muted-foreground',
                    selected.has(option.id) ? 'opacity-70' : 'opacity-0'
                  )}
                />
                <span className="min-w-0 truncate">{option.label}</span>
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

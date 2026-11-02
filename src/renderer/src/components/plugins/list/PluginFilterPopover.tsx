import { ListFilter } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Checkbox } from '../../ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '../../ui/popover'
import { NO_PLUGIN_LIST_FILTER, type PluginListFilter } from './plugin-list-filter'

function toggled(set: ReadonlySet<string>, value: string, on: boolean): Set<string> {
  const next = new Set(set)
  if (on) {
    next.add(value)
  } else {
    next.delete(value)
  }
  return next
}

function FilterOption({
  id,
  label,
  icon,
  count,
  checked,
  onChange
}: {
  id: string
  label: string
  icon?: React.ReactNode
  count?: number
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label
      htmlFor={id}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
    >
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </label>
  )
}

/** Narrow the list by catalog; categories are inline chips beside it. */
export function PluginFilterPopover({
  filter,
  sources,
  onChange
}: {
  filter: PluginListFilter
  sources: readonly PluginMarketplaceHostSourceState[]
  onChange: (filter: PluginListFilter) => void
}): React.JSX.Element {
  const active = filter.sourceIds.size
  const label = translate(
    'auto.components.settings.PluginFilterPopover.catalogLabel',
    'Filter by catalog'
  )
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={active > 0 ? 'secondary' : 'ghost'} size="sm" aria-label={label}>
          <ListFilter />
          {active > 0 ? <span className="tabular-nums">{active}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        {sources.length > 0 ? (
          <div
            role="group"
            aria-label={translate(
              'auto.components.settings.PluginFilterPopover.catalog',
              'Catalog'
            )}
          >
            <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
              {translate('auto.components.settings.PluginFilterPopover.catalog', 'Catalog')}
            </p>
            {sources.map((source) => (
              <FilterOption
                key={source.id}
                id={`plugin-filter-source-${source.id}`}
                label={source.marketplace?.name ?? source.source.url}
                checked={filter.sourceIds.has(source.id)}
                onChange={(on) =>
                  onChange({ ...filter, sourceIds: toggled(filter.sourceIds, source.id, on) })
                }
              />
            ))}
          </div>
        ) : null}
        <div className="mt-1 border-t border-border pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            disabled={active === 0}
            onClick={() => onChange({ ...filter, sourceIds: NO_PLUGIN_LIST_FILTER.sourceIds })}
          >
            {translate('auto.components.settings.PluginFilterPopover.clear', 'Clear filters')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

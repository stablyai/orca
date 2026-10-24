import { ListFilter } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  NO_PLUGIN_LIST_FILTER,
  pluginFilterSize,
  type PluginListFilter
} from '../plugin-catalog/plugin-list-filter'
import { pluginCategoryLabel } from '../plugin-catalog/plugin-category-label'

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
  count,
  checked,
  onChange
}: {
  id: string
  label: string
  count?: number
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  return (
    <label
      htmlFor={id}
      className="flex h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-accent"
    >
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined ? (
        <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
      ) : null}
    </label>
  )
}

/** Narrow the list by category and by catalog. */
export function PluginFilterPopover({
  filter,
  categories,
  sources,
  onChange
}: {
  filter: PluginListFilter
  categories: readonly [string, number][]
  sources: readonly PluginMarketplaceHostSourceState[]
  onChange: (filter: PluginListFilter) => void
}): React.JSX.Element {
  const active = pluginFilterSize(filter)
  const label = translate('auto.components.settings.PluginFilterPopover.label', 'Filter plugins')
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant={active > 0 ? 'secondary' : 'ghost'} size="sm" aria-label={label}>
          <ListFilter />
          {active > 0 ? <span className="tabular-nums">{active}</span> : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64">
        {categories.length > 0 ? (
          <div
            role="group"
            aria-label={translate('auto.components.settings.PluginFilterPopover.kind', 'Category')}
          >
            <p className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">
              {translate('auto.components.settings.PluginFilterPopover.kind', 'Category')}
            </p>
            {categories.map(([category, count]) => (
              <FilterOption
                key={category}
                id={`plugin-filter-category-${category}`}
                label={pluginCategoryLabel(category)}
                count={count}
                checked={filter.categories.has(category)}
                onChange={(on) =>
                  onChange({ ...filter, categories: toggled(filter.categories, category, on) })
                }
              />
            ))}
          </div>
        ) : null}
        {sources.length > 0 ? (
          <div
            role="group"
            aria-label={translate(
              'auto.components.settings.PluginFilterPopover.catalog',
              'Catalog'
            )}
            className="mt-1 border-t border-border pt-1"
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
            onClick={() => onChange(NO_PLUGIN_LIST_FILTER)}
          >
            {translate('auto.components.settings.PluginFilterPopover.clear', 'Clear filters')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

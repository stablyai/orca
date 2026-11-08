import { useTranslate } from '@/i18n/use-translate'
import { ToggleGroup, ToggleGroupItem } from '../../ui/toggle-group'
import { pluginCategoryLabel } from './plugin-category-label'
import { PluginCategoryIcon } from './PluginCategoryBadge'
import type { PluginListEntry } from './plugin-list-entries'
import { pluginFilterCategories, type PluginListFilter } from './plugin-list-filter'

/** One category at a time as always-visible chips; clicking the active one returns to all. */
export function PluginCategoryChips({
  entries,
  filter,
  onChange
}: {
  entries: readonly PluginListEntry[]
  filter: PluginListFilter
  onChange: (filter: PluginListFilter) => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const categories = pluginFilterCategories(entries).map(([category]) => category)
  if (categories.length === 0) {
    return null
  }
  return (
    <ToggleGroup
      type="single"
      variant="segmented"
      size="xs"
      spacing={1}
      value={[...filter.categories][0] ?? ''}
      onValueChange={(next) => onChange({ ...filter, categories: new Set(next ? [next] : []) })}
      aria-label={t('auto.components.settings.PluginFilterPopover.kind', 'Category')}
      className="flex-wrap"
    >
      {categories.map((category) => (
        <ToggleGroupItem key={category} value={category}>
          <PluginCategoryIcon category={category} />
          {pluginCategoryLabel(category, t)}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

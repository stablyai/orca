import { RefreshCw } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../../preload/api/plugins/plugin-host-api'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import type { PluginListFilter } from './plugin-list-filter'
import { isPluginCatalogSort, type PluginCatalogSort } from './plugin-catalog-sort'
import { PluginFilterPopover } from './PluginFilterPopover'

/** Tools beside the search: Update all (on the Updates filter), catalog filter, and refresh. */
export function PluginListToolbar({
  updateCount,
  onUpdateAll,
  filter,
  sources,
  onFilterChange,
  sort,
  onSortChange,
  sortApplies,
  refreshBusy,
  onRefresh
}: {
  /** Pending updates when the Updates tab is showing; 0 hides Update all. */
  updateCount: number
  onUpdateAll: () => void
  filter: PluginListFilter
  sources: readonly PluginMarketplaceHostSourceState[]
  onFilterChange: (filter: PluginListFilter) => void
  sort: PluginCatalogSort
  onSortChange: (sort: PluginCatalogSort) => void
  /** False on tabs whose rows this sort does not order (Installed, Updates). */
  sortApplies: boolean
  refreshBusy: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const refreshLabel = t('auto.components.settings.PluginManager.refreshLabel', 'Refresh catalogs')
  const sortLabel = t('auto.components.settings.PluginManager.sortLabel', 'Sort plugins')
  return (
    <>
      {updateCount > 0 ? (
        <Button variant="outline" size="sm" onClick={onUpdateAll}>
          {t('auto.components.settings.PluginManager.updateAll', 'Update all…')}
        </Button>
      ) : null}
      {sources.length > 0 ? (
        <PluginFilterPopover filter={filter} sources={sources} onChange={onFilterChange} />
      ) : null}
      {sortApplies ? (
        <Select
          value={sort}
          onValueChange={(value) => {
            if (isPluginCatalogSort(value)) {
              onSortChange(value)
            }
          }}
        >
        <SelectTrigger size="sm" aria-label={sortLabel}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value="default">
            {t('auto.components.settings.PluginManager.sortDefault', 'Default')}
          </SelectItem>
          <SelectItem value="most-installed">
            {t('auto.components.settings.PluginManager.sortMostInstalled', 'Most installed')}
          </SelectItem>
          <SelectItem value="recently-added">
            {t('auto.components.settings.PluginManager.sortRecentlyAdded', 'Recently added')}
          </SelectItem>
          <SelectItem value="recently-updated">
            {t('auto.components.settings.PluginManager.sortRecentlyUpdated', 'Recently updated')}
          </SelectItem>
          <SelectItem value="name">
            {t('auto.components.settings.PluginManager.sortName', 'Name')}
          </SelectItem>
        </SelectContent>
        </Select>
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={refreshBusy}
            aria-label={refreshLabel}
            onClick={onRefresh}
          >
            <RefreshCw className={refreshBusy ? 'animate-spin' : undefined} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {refreshLabel}
        </TooltipContent>
      </Tooltip>
    </>
  )
}

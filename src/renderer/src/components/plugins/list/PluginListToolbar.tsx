import { RefreshCw } from 'lucide-react'
import type { PluginMarketplaceHostSourceState } from '../../../../../preload/api-types'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import type { PluginListFilter } from './plugin-list-filter'
import { PluginFilterPopover } from './PluginFilterPopover'

/** Tools beside the search: Update all (on the Updates filter), catalog filter, and refresh. */
export function PluginListToolbar({
  updateCount,
  onUpdateAll,
  filter,
  sources,
  onFilterChange,
  refreshBusy,
  onRefresh
}: {
  /** Pending updates when the Updates tab is showing; 0 hides Update all. */
  updateCount: number
  onUpdateAll: () => void
  filter: PluginListFilter
  sources: readonly PluginMarketplaceHostSourceState[]
  onFilterChange: (filter: PluginListFilter) => void
  refreshBusy: boolean
  onRefresh: () => void
}): React.JSX.Element {
  const refreshLabel = translate(
    'auto.components.settings.PluginManager.refreshLabel',
    'Refresh catalogs'
  )
  return (
    <>
      {updateCount > 0 ? (
        <Button variant="outline" size="sm" onClick={onUpdateAll}>
          {translate('auto.components.settings.PluginManager.updateAll', 'Update all…')}
        </Button>
      ) : null}
      {sources.length > 0 ? (
        <PluginFilterPopover filter={filter} sources={sources} onChange={onFilterChange} />
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

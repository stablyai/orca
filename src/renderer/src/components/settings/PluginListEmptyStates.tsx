import { ChevronLeft, Loader2, SearchX } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { PluginCatalogEmptyState } from '../plugin-catalog/PluginCatalogEmptyState'

/** Nothing matches the search and/or filters; one button clears whatever is narrowing. */
export function PluginNoMatches({
  query,
  filtered,
  onClear
}: {
  query: string
  filtered: boolean
  onClear: () => void
}): React.JSX.Element {
  return (
    <PluginCatalogEmptyState
      icon={SearchX}
      title={
        query
          ? translate(
              'auto.components.settings.PluginManager.noResultsTitle',
              'No plugins match “{{value0}}”',
              { value0: query }
            )
          : translate(
              'auto.components.settings.PluginListEmptyStates.noFilterMatches',
              'No plugins match these filters'
            )
      }
      description={translate(
        'auto.components.settings.PluginManager.noResults',
        'Search looks at names, descriptions, publishers and categories.'
      )}
      action={
        <Button variant="outline" size="sm" onClick={onClear}>
          {query && filtered
            ? translate(
                'auto.components.settings.PluginListEmptyStates.clearBoth',
                'Clear search and filters'
              )
            : query
              ? translate(
                  'auto.components.settings.PluginMarketplaceBrowser.clearSearch',
                  'Clear search'
                )
              : translate('auto.components.settings.PluginFilterPopover.clear', 'Clear filters')}
        </Button>
      }
    />
  )
}

/** An open page whose plugin is gone (removed elsewhere) or not loaded yet. */
export function PluginPageMissing({
  loading,
  onBack
}: {
  loading: boolean
  onBack: () => void
}): React.JSX.Element {
  return (
    <div>
      <Button variant="ghost" size="xs" className="-ml-2" onClick={onBack}>
        <ChevronLeft />
        {translate('auto.components.settings.PluginDetailPage.back', 'Plugins')}
      </Button>
      {loading ? (
        <Loader2 className="mx-auto mt-10 size-4 animate-spin text-muted-foreground" />
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          {translate(
            'auto.components.settings.PluginListEmptyStates.pageGone',
            'This plugin is no longer installed or listed.'
          )}
        </p>
      )}
    </div>
  )
}

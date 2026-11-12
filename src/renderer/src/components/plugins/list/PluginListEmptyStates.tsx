import { Blocks, ChevronLeft, Loader2, PackageCheck, SearchX } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { PluginCatalogEmptyState } from './PluginCatalogEmptyState'

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
  const t = useTranslate()
  return (
    <PluginCatalogEmptyState
      icon={SearchX}
      title={
        query
          ? t(
              'auto.components.settings.PluginManager.noResultsTitle',
              'No plugins match “{{value0}}”',
              { value0: query }
            )
          : t(
              'auto.components.settings.PluginListEmptyStates.noFilterMatches',
              'No plugins match these filters'
            )
      }
      action={
        <Button variant="outline" size="sm" onClick={onClear}>
          {query && filtered
            ? t(
                'auto.components.settings.PluginListEmptyStates.clearBoth',
                'Clear search and filters'
              )
            : query
              ? t('auto.components.settings.PluginMarketplaceBrowser.clearSearch', 'Clear search')
              : t('auto.components.settings.PluginFilterPopover.clear', 'Clear filters')}
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
  const t = useTranslate()
  return (
    <div>
      <Button variant="ghost" size="xs" className="-ml-2" onClick={onBack}>
        <ChevronLeft />
        {t('auto.components.settings.PluginDetailPage.back', 'Plugins')}
      </Button>
      {loading ? (
        <Loader2 className="mx-auto mt-10 size-4 animate-spin text-muted-foreground" />
      ) : (
        <p className="mt-6 text-sm text-muted-foreground">
          {t(
            'auto.components.settings.PluginListEmptyStates.pageGone',
            'This plugin is no longer installed or listed.'
          )}
        </p>
      )}
    </div>
  )
}

/** The Installed or Updates filter with nothing installed. */
export function PluginNoneInstalled({ onBrowse }: { onBrowse: () => void }): React.JSX.Element {
  const t = useTranslate()
  return (
    <PluginCatalogEmptyState
      icon={Blocks}
      title={t('auto.components.settings.PluginManager.noneInstalledTitle', 'No plugins installed')}
      action={
        <Button variant="outline" size="sm" onClick={onBrowse}>
          {t('auto.components.settings.PluginManager.browseAll', 'Browse all plugins')}
        </Button>
      }
    />
  )
}

/** The Not installed filter once every catalog plugin is installed. */
export function PluginAllInstalled({
  onShowInstalled
}: {
  onShowInstalled: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <PluginCatalogEmptyState
      icon={PackageCheck}
      title={t(
        'auto.components.settings.PluginManager.allInstalledTitle',
        'Every catalog plugin is installed'
      )}
      action={
        <Button variant="outline" size="sm" onClick={onShowInstalled}>
          {t('auto.components.settings.PluginManager.showInstalled', 'Show installed plugins')}
        </Button>
      }
    />
  )
}

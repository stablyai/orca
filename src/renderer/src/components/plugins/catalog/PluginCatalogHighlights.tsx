import { useNow } from '@/hooks/use-now'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { formatAddedAgo } from '../../../../../shared/plugins/catalog/plugin-added-at'
import { usePluginInstallCountsStore } from '@/store/plugins/installation/plugin-install-counts'
import { PluginListGroup } from '../list/PluginListGroup'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { pluginListedAt } from '../list/plugin-listed-at'
import { CatalogCard, type CatalogCardHandlers } from './PluginCatalogGroups'
import { pickCatalogHighlights } from './plugin-catalog-highlights'

/** Featured and Newly added rows above the catalogs; Featured shows only alongside Newly added. */
export function PluginCatalogHighlights({
  entries,
  orcaVersion,
  cardHandlers
}: {
  /** Installed and listed plugins; the rows offer only ones that can be installed now. */
  entries: readonly PluginListEntry[]
  orcaVersion: string | null
  cardHandlers: CatalogCardHandlers
}): React.JSX.Element | null {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const installCounts = usePluginInstallCountsStore((state) => state.counts)
  const now = useNow(60_000)
  const { featured, newlyAdded } = pickCatalogHighlights(entries, installCounts, orcaVersion, now)
  if (featured.length === 0 && newlyAdded.length === 0) {
    return null
  }
  const addedLabel = (entry: PluginListEntry): string | undefined => {
    const addedAt = pluginListedAt(entry)
    const ago =
      addedAt &&
      formatAddedAgo(addedAt, now, {
        locale: intlLocale,
        justNow: t('auto.components.plugins.PluginCatalogHighlights.justNow', 'just now')
      })
    return ago
      ? t('auto.components.plugins.PluginCatalogHighlights.added', 'Added {{value0}}', {
          value0: ago
        })
      : undefined
  }
  return (
    <>
      {/* Why one row of up to four: Featured is a responsive teaser, per the approved mock, not an
          exhaustive one-per-category list; the catalogs below still list every plugin. */}
      {featured.length > 0 ? (
        <PluginListGroup
          layout="grid"
          singleRow
          title={t('auto.components.plugins.PluginCatalogHighlights.featured', 'Featured')}
          detail={t(
            'auto.components.plugins.PluginCatalogHighlights.featuredDetail',
            'most installed, one per category'
          )}
        >
          {featured.map((entry) => (
            <CatalogCard key={entry.pluginKey} entry={entry} handlers={cardHandlers} />
          ))}
        </PluginListGroup>
      ) : null}
      {newlyAdded.length > 0 ? (
        <PluginListGroup
          layout="grid"
          title={t('auto.components.plugins.PluginCatalogHighlights.newlyAdded', 'Newly added')}
          detail={t(
            'auto.components.plugins.PluginCatalogHighlights.newlyAddedDetail',
            'across your catalogs'
          )}
        >
          {newlyAdded.map((entry) => (
            <CatalogCard
              key={entry.pluginKey}
              entry={entry}
              handlers={cardHandlers}
              metaDetail={addedLabel(entry)}
            />
          ))}
        </PluginListGroup>
      ) : null}
    </>
  )
}

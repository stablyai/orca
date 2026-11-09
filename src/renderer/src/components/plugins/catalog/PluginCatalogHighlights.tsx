import { ChevronRight } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import { useTranslate } from '@/i18n/use-translate'
import { formatShortTimeAgo } from '@/lib/short-time-ago'
import { usePluginInstallCountsStore } from '@/store/plugins/installation/plugin-install-counts'
import { Button } from '../../ui/button'
import { PluginListGroup } from '../list/PluginListGroup'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { pluginListedAgoMs } from '../list/plugin-listed-at'
import { CatalogCard, type CatalogCardHandlers } from './PluginCatalogGroups'
import { pickFeaturedPlugins, pickNewlyAddedPlugins } from './plugin-catalog-highlights'

/** Featured and Newly added rows above the catalogs; each hides itself when it has nothing to show. */
export function PluginCatalogHighlights({
  entries,
  orcaVersion,
  cardHandlers,
  onSeeAllNew
}: {
  /** Installed and listed plugins; the rows offer only ones that can be installed now. */
  entries: readonly PluginListEntry[]
  orcaVersion: string | null
  cardHandlers: CatalogCardHandlers
  onSeeAllNew: () => void
}): React.JSX.Element | null {
  const t = useTranslate()
  const installCounts = usePluginInstallCountsStore((state) => state.counts)
  const now = useNow(60_000)
  const featured = pickFeaturedPlugins(entries, installCounts, orcaVersion)
  const newlyAdded = pickNewlyAddedPlugins(entries, orcaVersion, now)
  if (featured.length === 0 && !newlyAdded) {
    return null
  }
  const addedLabel = (entry: PluginListEntry): string | undefined => {
    const ago = pluginListedAgoMs(entry, now)
    if (ago === null) {
      return undefined
    }
    const short = formatShortTimeAgo(now - ago, now)
    return short === 'now'
      ? t('auto.components.plugins.PluginCatalogHighlights.addedJustNow', 'Added just now')
      : t('auto.components.plugins.PluginCatalogHighlights.addedAgo', 'Added {{value0}} ago', {
          value0: short
        })
  }
  return (
    <>
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
      {newlyAdded ? (
        <PluginListGroup
          layout="grid"
          singleRow
          title={t('auto.components.plugins.PluginCatalogHighlights.newlyAdded', 'Newly added')}
          detail={t(
            'auto.components.plugins.PluginCatalogHighlights.newlyAddedDetail',
            'across your catalogs'
          )}
          aside={
            newlyAdded.thisWeek > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                {t(
                  'auto.components.plugins.PluginCatalogHighlights.thisWeek',
                  '{{value0}} this week',
                  { value0: newlyAdded.thisWeek }
                )}
                <span aria-hidden="true">·</span>
                <Button
                  variant="link"
                  size="xs"
                  className="h-auto gap-0.5 p-0 text-xs text-foreground has-[>svg]:px-0"
                  onClick={onSeeAllNew}
                >
                  {t('auto.components.plugins.PluginCatalogHighlights.seeAll', 'See all')}
                  <ChevronRight className="size-3.5" />
                </Button>
              </span>
            ) : undefined
          }
        >
          {newlyAdded.rows.map((entry) => (
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

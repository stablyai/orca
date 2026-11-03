import { useCallback, useMemo, useState } from 'react'
import type { PluginMarketplaceHostListing } from '../../../../preload/api-types'
import type { CardTemplate } from '../../../../shared/workspace-cards/card-template-schema'
import { cardTemplateIssues } from '../../../../shared/workspace-cards/card-template-validation'
import { buildPluginListEntries, needsNewerOrca } from '../plugins/list/plugin-list-entries'
import { createPluginPagePreviewCache } from '../plugins/state/use-plugin-catalog'
import {
  usePluginInstallAction,
  type PluginInstallPhase
} from '../plugins/state/use-plugin-install-action'
import { useCatalogSnapshot, type CatalogSnapshot } from '../settings/use-catalog-app-themes'

/** One workspace card a catalog offers, as its release previews it. */
export type CatalogCard = {
  key: string
  label: string
  pluginName: string
  template: CardTemplate
  listing: PluginMarketplaceHostListing
}

/** Cards from content-only plugins that are not installed and that this Orca can draw. */
export function catalogCards(
  snapshot: CatalogSnapshot,
  installedPluginKeys: ReadonlySet<string>
): CatalogCard[] {
  return buildPluginListEntries(snapshot.installed, snapshot.listings)
    .available.flatMap((entry) => {
      const { listing } = entry
      const release = listing?.release
      if (
        !listing ||
        !release ||
        installedPluginKeys.has(entry.pluginKey) ||
        listing.blockedByKillList ||
        // Why content only: a card with code is reviewed on its plugin page first.
        release.execution !== 'data' ||
        needsNewerOrca(entry.minimumOrca, snapshot.orcaVersion)
      ) {
        return []
      }
      return (release.cardPreview ?? []).flatMap((preview, index) =>
        cardTemplateIssues(preview.template).length === 0
          ? [
              {
                key: `${entry.pluginKey}:${index}`,
                label: preview.label,
                pluginName: entry.name,
                template: preview.template,
                listing
              }
            ]
          : []
      )
    })
    .sort((left, right) => left.label.localeCompare(right.label))
}

/** The catalog's cards for the Card Studio, read when it opens, with a one-click install. */
export function useCatalogCards(
  installedPluginKeys: ReadonlySet<string>,
  enabled: boolean
): {
  cards: CatalogCard[]
  loading: boolean
  load: () => void
  install: (card: CatalogCard) => void
  phaseOf: (card: CatalogCard) => PluginInstallPhase | null
} {
  const { snapshot, loading, load } = useCatalogSnapshot()
  const cards = useMemo(
    () => (enabled && snapshot ? catalogCards(snapshot, installedPluginKeys) : []),
    [enabled, snapshot, installedPluginKeys]
  )
  const [previewCache] = useState(createPluginPagePreviewCache)
  const fetchPreview = useCallback(
    (listing: PluginMarketplaceHostListing) => previewCache.fetch(listing),
    [previewCache]
  )
  const onInstalled = useCallback(async () => load(), [load])
  const action = usePluginInstallAction({ fetchPreview, onInstalled })
  return {
    cards,
    loading: enabled && loading && !snapshot,
    load,
    install: (card) => void action.install(card.listing),
    phaseOf: (card) => action.phaseOf(card.listing.pluginKey)
  }
}

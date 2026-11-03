import React, { useEffect, useMemo } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { usePluginSidebarCards } from '@/store/plugin-sidebar-cards'
import { CardStudioSection } from './CardStudioSection'
import { useCatalogCards, type CatalogCard } from './use-catalog-cards'

/** Cards from the plugin catalog: preview in the gallery before install, install in one click. */
export function CardStudioMarketplace({
  previewKey,
  onPreview
}: {
  previewKey: string | null
  onPreview: (card: CatalogCard | null) => void
}): React.JSX.Element | null {
  const enabled = useAppStore((s) => s.settings?.pluginSystemEnabled === true)
  const installed = usePluginSidebarCards()
  const installedKeys = useMemo(() => new Set(installed.map((card) => card.pluginKey)), [installed])
  const { cards, loading, load, install, phaseOf } = useCatalogCards(installedKeys, enabled)
  useEffect(() => {
    if (enabled) {
      load()
    }
  }, [enabled, load])
  if (!enabled) {
    return null
  }
  return (
    <CardStudioSection title={translate('auto.components.cardStudio.moreCards', 'More cards')}>
      {loading ? (
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.cardStudio.loadingCatalog', 'Reading the plugin catalog…')}
        </p>
      ) : cards.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          {translate('auto.components.cardStudio.noCatalogCards', 'No other cards in the catalog.')}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {cards.map((card) => {
            const phase = phaseOf(card)
            const previewing = previewKey === card.key
            return (
              <li key={card.key} className="flex items-center gap-2">
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm">{card.label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {phase?.kind === 'error' ? phase.message : card.pluginName}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="xs"
                  aria-pressed={previewing}
                  onClick={() => onPreview(previewing ? null : card)}
                >
                  {previewing
                    ? translate('auto.components.cardStudio.stopPreview', 'Stop preview')
                    : translate('auto.components.cardStudio.previewCard', 'Preview')}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={phase?.kind === 'installing'}
                  onClick={() => install(card)}
                >
                  {phase?.kind === 'installing'
                    ? translate('auto.components.cardStudio.installing', 'Installing…')
                    : translate('auto.components.cardStudio.install', 'Install')}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </CardStudioSection>
  )
}

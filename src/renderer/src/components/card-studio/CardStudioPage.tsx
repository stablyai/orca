import React, { useEffect } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { ensurePluginSidebarCardsLoaded } from '@/store/plugin-sidebar-cards'
import { CardStudioCardPicker } from './CardStudioCardPicker'
import { CardStudioGallery } from './CardStudioGallery'
import { CardStudioOrcaOptions } from './CardStudioOrcaOptions'
import { CardStudioPluginOptions } from './CardStudioPluginOptions'
import { CardStudioSection } from './CardStudioSection'

/** Customize workspace cards; the sidebar stays live beside it and shows every change at once. */
export default function CardStudioPage(): React.JSX.Element {
  const closeCardStudio = useAppStore((s) => s.closeCardStudio)
  const cardId = useAppStore((s) => s.settings?.workspaceCardId)
  useEffect(() => ensurePluginSidebarCardsLoaded(), [])
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        closeCardStudio()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeCardStudio])

  return (
    <main className="relative flex h-full min-h-0 flex-1 flex-col bg-background pt-5 text-foreground md:pt-6">
      <header
        className="flex shrink-0 items-center gap-3 px-3 pb-3 md:px-5"
        // Why: no stacked center titlebar on this page; keep the close button clear of window controls.
        style={{ paddingRight: 'max(0.75rem, var(--window-controls-width, 0px))' }}
      >
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold leading-8">
            {translate('auto.components.cardStudio.title', 'Workspace cards')}
          </h1>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.cardStudio.subtitle',
              'Choose what each card in the sidebar shows. Changes apply right away.'
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={closeCardStudio}
          aria-label={translate('auto.components.cardStudio.close', 'Close')}
        >
          <X />
        </Button>
      </header>
      <div className="flex min-h-0 flex-1 gap-6 overflow-hidden px-3 pb-5 md:px-5">
        <aside className="scrollbar-sleek flex w-72 shrink-0 flex-col gap-6 overflow-y-auto pr-1">
          <CardStudioSection title={translate('auto.components.cardStudio.card', 'Card')}>
            <CardStudioCardPicker />
          </CardStudioSection>
          {cardId ? <CardStudioPluginOptions cardId={cardId} /> : null}
          <CardStudioOrcaOptions />
        </aside>
        <section className="scrollbar-sleek min-w-0 flex-1 overflow-y-auto">
          <CardStudioSection
            title={translate('auto.components.cardStudio.preview', 'Your workspaces')}
          >
            <CardStudioGallery />
          </CardStudioSection>
        </section>
      </div>
    </main>
  )
}

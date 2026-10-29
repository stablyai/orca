import { useEffect, useId, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { CatalogCard, type CatalogCardHandlers } from './PluginCatalogGroups'

/** The All tab's top row: every installed plugin as its card, scrolled a page at a time. */
export function InstalledPluginCarousel({
  entries,
  handlers,
  onSeeAll
}: {
  entries: readonly PluginListEntry[]
  handlers: CatalogCardHandlers
  onSeeAll: () => void
}): React.JSX.Element | null {
  const headingId = useId()
  const listRef = useRef<HTMLUListElement>(null)
  const [edges, setEdges] = useState({ start: true, end: true })
  const measure = (): void => {
    const list = listRef.current
    if (list) {
      // Why 1px slack: fractional card widths leave the end a subpixel short.
      setEdges({
        start: list.scrollLeft <= 1,
        end: list.scrollLeft + list.clientWidth >= list.scrollWidth - 1
      })
    }
  }
  useEffect(() => {
    const list = listRef.current
    if (!list) {
      return
    }
    const observer = new ResizeObserver(measure)
    observer.observe(list)
    return () => observer.disconnect()
  }, [entries.length])
  if (entries.length === 0) {
    return null
  }
  // Why by card pitch: a page of whole cards keeps the next one on its snap point.
  const page = (direction: 1 | -1): void => {
    const list = listRef.current
    const [first, second] = list ? Array.from(list.children) : []
    if (!list || !(first instanceof HTMLElement)) {
      return
    }
    const pitch =
      second instanceof HTMLElement ? second.offsetLeft - first.offsetLeft : first.offsetWidth
    const perPage = Math.max(1, Math.round(list.clientWidth / pitch))
    list.scrollBy({ left: direction * pitch * perPage })
  }
  return (
    <section data-installed-carousel="" aria-labelledby={headingId}>
      <div className="flex items-center gap-2 px-0.5 pb-2.5">
        <h3
          id={headingId}
          className="text-2xs font-semibold tracking-[0.05em] text-muted-foreground uppercase"
        >
          {translate(
            'auto.components.settings.InstalledPluginCarousel.title',
            'Installed · {{value0}}',
            {
              value0: entries.length
            }
          )}
        </h3>
        <Button variant="link" size="xs" className="ml-auto" onClick={onSeeAll}>
          {translate('auto.components.settings.InstalledPluginCarousel.seeAll', 'See all')}
        </Button>
        {edges.start && edges.end ? null : (
          <>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={edges.start}
              aria-label={translate(
                'auto.components.settings.InstalledPluginCarousel.previous',
                'Previous installed plugins'
              )}
              onClick={() => page(-1)}
            >
              <ChevronLeft />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              disabled={edges.end}
              aria-label={translate(
                'auto.components.settings.InstalledPluginCarousel.next',
                'Next installed plugins'
              )}
              onClick={() => page(1)}
            >
              <ChevronRight />
            </Button>
          </>
        )}
      </div>
      {/* Why the cards' widths: the row matches the catalog grid below it, column for column. Why no scrollbar: the arrows page it; wheel, trackpad and focus still scroll. */}
      <ul
        ref={listRef}
        onScroll={measure}
        className="flex snap-x snap-mandatory scroll-px-0.5 gap-4 overflow-x-auto p-0.5 scrollbar-none motion-safe:scroll-smooth *:shrink-0 *:basis-full *:snap-start @min-[460px]/plugin-catalog:*:basis-[calc((100%-1rem)/2)] @min-[720px]/plugin-catalog:*:basis-[calc((100%-2rem)/3)]"
      >
        {entries.map((entry) => (
          <CatalogCard key={entry.pluginKey} entry={entry} handlers={handlers} />
        ))}
      </ul>
    </section>
  )
}

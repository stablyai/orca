import { useEffect, useId, useRef, useState } from 'react'
import { ArrowRight, ChevronLeft, ChevronRight } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../../ui/button'
import type { PluginListEntry } from '../list/plugin-list-entries'
import { CatalogCard, type CatalogCardHandlers } from './PluginCatalogGroups'

// Why: the catalog grid's column breakpoints (PluginListGroup), as container widths.
const COLUMN_BREAKPOINTS = [460, 720, 1056]

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
  const [columns, setColumns] = useState(1)
  const measure = (): void => {
    const list = listRef.current
    if (list) {
      // Why 1px slack: fractional card widths leave the end a subpixel short.
      setEdges({
        start: list.scrollLeft <= 1,
        end: list.scrollLeft + list.clientWidth >= list.scrollWidth - 1
      })
      setColumns(1 + COLUMN_BREAKPOINTS.filter((width) => list.clientWidth >= width).length)
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
    // Why columns: toggling the peek resizes the cards, not the list, so the edges need a re-measure.
  }, [entries.length, columns])
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
          {translate('auto.components.settings.InstalledPluginCarousel.heading', 'Installed')}
        </h3>
        <Button variant="outline" size="xs" onClick={onSeeAll}>
          {translate(
            'auto.components.settings.InstalledPluginCarousel.seeAllCount',
            'See all {{value0}}',
            { value0: entries.length }
          )}
          <ArrowRight />
        </Button>
        {edges.start && edges.end ? null : (
          <div className="ml-auto flex items-center gap-1">
            <Button
              variant="outline"
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
              variant="outline"
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
          </div>
        )}
      </div>
      {/* Why the cards' widths: the catalog grid's columns, less a peek of the next card when more follow. Why no scrollbar: the arrows page it; wheel, trackpad and focus still scroll. */}
      <ul
        ref={listRef}
        onScroll={measure}
        data-peek={entries.length > columns}
        className="flex snap-x snap-mandatory scroll-px-0.5 gap-4 overflow-x-auto p-0.5 scrollbar-none [--peek-gap:0px] [--peek:0] motion-safe:scroll-smooth data-[peek=true]:[--peek-gap:1rem] data-[peek=true]:[--peek:0.2] *:shrink-0 *:basis-[calc((100%-var(--peek-gap))/(1+var(--peek)))] *:snap-start @min-[460px]/plugin-catalog:*:basis-[calc((100%-1rem-var(--peek-gap))/(2+var(--peek)))] @min-[720px]/plugin-catalog:*:basis-[calc((100%-2rem-var(--peek-gap))/(3+var(--peek)))] @min-[1056px]/plugin-catalog:*:basis-[calc((100%-3rem-var(--peek-gap))/(4+var(--peek)))]"
      >
        {entries.map((entry) => (
          <CatalogCard key={entry.pluginKey} entry={entry} handlers={handlers} />
        ))}
      </ul>
    </section>
  )
}

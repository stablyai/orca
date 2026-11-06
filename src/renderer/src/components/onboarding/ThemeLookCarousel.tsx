import type React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Check, ChevronLeft, ChevronRight, ExternalLink, Puzzle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import type { ThemeLook } from './onboarding-theme-looks'
import { ThemeLookCardPreview } from './ThemeLookPreview'

export const THEME_PLUGINS_URL = 'https://onorca.dev/plugins?kind=themes'

export function openThemePluginDirectory(): void {
  // Why the system browser: onboarding has no workspace browser to host the directory.
  void window.api.shell.openUrl(THEME_PLUGINS_URL)
}

type ScrollEdges = { start: boolean; end: boolean }

function readEdges(el: HTMLElement): ScrollEdges {
  return {
    start: el.scrollLeft <= 1,
    end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
  }
}

/** Optional looks for one mode in a snap carousel; click or Enter applies, the app repaints live. */
export function ThemeLookCarousel({
  looks,
  selectedId,
  onPick,
  ariaLabel,
  header
}: {
  looks: ThemeLook[]
  selectedId: string | null
  onPick: (look: ThemeLook) => void
  ariaLabel: string
  header: React.ReactNode
}): React.JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState<ScrollEdges>({ start: true, end: false })
  const tabStopId = looks.some((look) => look.id === selectedId) ? selectedId : looks[0]?.id

  // Why: bring the applied look into view when the mode or slot swaps the card set.
  useEffect(() => {
    const el = trackRef.current
    if (!el) {
      return
    }
    const card = selectedId
      ? el.querySelector<HTMLElement>(`[data-theme-look="${CSS.escape(selectedId)}"]`)
      : null
    el.scrollLeft = card
      ? Math.max(0, card.offsetLeft - (el.clientWidth - card.clientWidth) / 2)
      : 0
    setEdges(readEdges(el))
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on card-set swaps, not every pick
  }, [looks])

  const page = (direction: 1 | -1): void => {
    const el = trackRef.current
    el?.scrollBy({ left: direction * el.clientWidth * 0.8, behavior: 'smooth' })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const moves: Record<string, (index: number) => number> = {
      ArrowRight: (index) => Math.min(index + 1, looks.length - 1),
      ArrowLeft: (index) => Math.max(index - 1, 0),
      Home: () => 0,
      End: () => looks.length - 1
    }
    const move = moves[event.key]
    const targetId = event.target instanceof HTMLElement ? event.target.dataset.themeLook : null
    const current = looks.findIndex((look) => look.id === targetId)
    if (!move || current === -1) {
      return
    }
    event.preventDefault()
    const next = looks[move(current)]
    event.currentTarget
      .querySelector<HTMLElement>(`[data-theme-look="${CSS.escape(next.id)}"]`)
      ?.focus()
  }

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{header}</div>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={edges.start}
          aria-label={translate('components.onboarding.theme.looks.previous', 'Previous looks')}
          onClick={() => page(-1)}
        >
          <ChevronLeft />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={edges.end}
          aria-label={translate('components.onboarding.theme.looks.next', 'More looks')}
          onClick={() => page(1)}
        >
          <ChevronRight />
        </Button>
      </div>
      <div
        ref={trackRef}
        role="group"
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        onScroll={(event) => setEdges(readEdges(event.currentTarget))}
        className={cn(
          'scrollbar-none relative -mx-1 flex snap-x snap-mandatory scroll-px-1 gap-2.5 overflow-x-auto px-1 py-1',
          !edges.start &&
            !edges.end &&
            '[mask-image:linear-gradient(to_right,transparent,black_3rem,black_calc(100%-3rem),transparent)]',
          edges.start &&
            !edges.end &&
            '[mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)]',
          !edges.start &&
            edges.end &&
            '[mask-image:linear-gradient(to_right,transparent,black_3rem)]'
        )}
      >
        {looks.map((look) => {
          const selected = look.id === selectedId
          return (
            <button
              key={look.id}
              type="button"
              aria-pressed={selected}
              tabIndex={look.id === tabStopId ? 0 : -1}
              data-theme-look={look.id}
              title={`${look.label} · ${look.source}`}
              className={cn(
                'w-40 shrink-0 snap-start rounded-lg border p-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                selected ? 'border-foreground/60 bg-accent' : 'border-border hover:bg-accent/60'
              )}
              onClick={() => onPick(look)}
            >
              <div className="relative h-[4.5rem] overflow-hidden rounded-md border border-border">
                <ThemeLookCardPreview palette={look.palette} />
                {selected && (
                  <div className="absolute right-1 top-1 grid size-4 place-items-center rounded-full bg-foreground text-background shadow-sm">
                    <Check className="size-2.5" strokeWidth={3} />
                  </div>
                )}
              </div>
              <div className="truncate px-0.5 pt-1.5 text-xs font-medium text-foreground">
                {look.label}
              </div>
              <div className="truncate px-0.5 text-2xs text-muted-foreground">{look.source}</div>
            </button>
          )
        })}
        <button
          type="button"
          className="flex w-40 shrink-0 snap-start flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border p-1.5 text-center text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          onClick={openThemePluginDirectory}
        >
          <Puzzle className="size-4" />
          <span className="text-xs font-medium">
            {translate('components.onboarding.theme.looks.moreThemes', 'More themes')}
          </span>
          <span className="flex items-center gap-1 text-2xs">
            {translate('components.onboarding.theme.looks.browsePlugins', 'Browse plugins')}
            <ExternalLink className="size-2.5" />
          </span>
        </button>
      </div>
    </section>
  )
}

// The Items list while its first read is out: a section header and five rows drawn as quiet bars at the
// real header's and rows' geometry (status dot, #number, title, age), so the first header and rows land where
// the loaded list's do.
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'

// Why: the app's skeleton bg-muted is the sidebar's own shade in light (#f5f5f5 on #fafafa), so these bars
// take muted-foreground at low alpha, which reads quietly on the panel in both themes.
const BAR = 'animate-pulse rounded bg-muted-foreground/15 motion-reduce:animate-none'

/** Title widths per row, of the space the title gets, so the bars read as text rather than a grid. */
const TITLE_WIDTHS = ['w-[78%]', 'w-[62%]', 'w-[85%]', 'w-[54%]', 'w-[70%]'] as const

export function BotItemsLoading({
  afterAsks = false
}: {
  /** Orca's asks already show Needs you above: the bars sit a section's gap below it, as their own group. */
  afterAsks?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      // Why: no aria-busy; on the live region itself it lets assistive tech hold back this label.
      role="status"
      className={cn(
        // Why: the list above stays mounted while loading, so the panel's gap-3.5 sits between it and these
        // bars. Empty, pulling up by that gap draws them where its first header lands; under the asks, by
        // all but the list's own gap-2 between sections.
        afterAsks ? '-mt-1.5' : '-mt-3.5',
        // Why: a read that lands within 150 ms shows nothing rather than a one-frame flash of bars.
        'flex flex-col gap-0.5 animate-in fade-in-0 fill-mode-backwards delay-150 motion-reduce:duration-0'
      )}
    >
      <span className="sr-only">{t('bots.items.loading', 'Loading items…')}</span>
      {/* BotPanelSectionHeader's h-7 row; its title starts after pl-1, the chevron's ml-0.5 size-5, and gap-1. */}
      <div aria-hidden className="flex h-7 items-center pl-[30px]">
        <span className={cn(BAR, 'h-2 w-16')} />
      </div>
      {TITLE_WIDTHS.map((width) => (
        // BotItemRow's geometry: px-2 py-1 around a 20 px line, the status slot w-4, then gap-2.
        <div key={width} aria-hidden className="flex items-center gap-2 px-2 py-1">
          <span className="flex h-5 w-4 shrink-0 items-center justify-center">
            <span className={cn(BAR, 'size-2 rounded-full')} />
          </span>
          <span className="flex min-w-0 flex-1 items-center">
            {/* BotItemNumberColumn's width at three digits, so titles start where #123's do. */}
            <span className="flex h-5 min-w-[calc(4ch+0.375rem)] shrink-0 items-center pr-1.5 text-[13px] tabular-nums">
              <span className={cn(BAR, 'h-2.5 w-7')} />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1">
                <span className={cn(BAR, 'block h-2.5', width)} />
              </span>
              <span className={cn(BAR, 'h-2.5 w-[18px] shrink-0 @max-[284px]:hidden')} />
            </span>
          </span>
        </div>
      ))}
    </div>
  )
}

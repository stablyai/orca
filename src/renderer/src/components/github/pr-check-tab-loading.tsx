import { cn } from '@/lib/class-names'
import { CheckRowsLoading } from '@/components/right-sidebar/checks-panel/presentation/checks-list-loading'

const bar = 'block shrink-0 rounded bg-muted-foreground/15'
// Why: a fast read never flashes bars; reduced motion skips the fade and shows them at once.
const fade = 'animate-in fade-in-0 fill-mode-backwards delay-150 motion-reduce:animate-none'

/** The compact header's one-line summary slot while the first read runs. */
export function PRChecksSummaryLineLoading(): React.JSX.Element {
  return (
    <div aria-hidden="true" className={cn('flex h-4 items-center', fade)}>
      <span className={cn(bar, 'h-2 w-24')} />
    </div>
  )
}

/**
 * Cold-read Checks tab for the PR page and the item dialog. Real chrome (the compact header, the
 * page actions) renders as-is; only the unknown summary and check rows are bars, at the loaded geometry.
 */
export function PRChecksTabLoading({
  variant,
  compactHeader,
  actions
}: {
  variant: 'compact' | 'page'
  compactHeader: React.JSX.Element
  actions: React.JSX.Element
}): React.JSX.Element {
  if (variant === 'compact') {
    return (
      <>
        {compactHeader}
        <div aria-hidden="true" className={cn('overflow-hidden p-1', fade)}>
          {/* Why: loaded compact rows are 12px text on an 18px line plus py-1.5. */}
          <CheckRowsLoading rowClassName="h-[30px] px-2" trailing="label" onCard />
        </div>
      </>
    )
  }
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div aria-hidden="true" className={cn('flex min-w-0 flex-1 items-center gap-3', fade)}>
          <span className={cn(bar, 'size-4 rounded-full')} />
          <span className={cn(bar, 'h-2.5 w-32 max-w-1/2')} />
        </div>
        {actions}
      </div>
      <div
        aria-hidden="true"
        className={cn('overflow-hidden rounded-lg border border-border/50 bg-card shadow-xs', fade)}
      >
        {/* Why: loaded page rows are 12px text on an 18px line plus py-2.5. */}
        <CheckRowsLoading rowClassName="h-[38px] px-3" trailing="label" onCard divided />
      </div>
    </div>
  )
}

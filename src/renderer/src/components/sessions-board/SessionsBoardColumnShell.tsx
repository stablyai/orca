import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

// Why: a machine-wide board can carry a column per agent type, and most of them
// are noise on any given day — collapsing folds one back to a rail that still
// reports its count, so nothing disappears without a trace.

const RAIL_WIDTH_CLASS = 'w-14 min-w-14'

/**
 * The board's column chrome, with no idea what a column holds.
 *
 * Why it says nothing about agents: the board now carries a column per *site* beside a column per
 * agent, and those two hold records with no field in common. What the two genuinely share is the
 * shell — rail, header, count and the scrolling card list — so that is what lives here, and the
 * caller supplies the icon and the cards.
 */
export function SessionsBoardColumnShell({
  columnKey,
  testIdPrefix = 'sessions-board-column',
  label,
  count,
  icon,
  railIcon,
  collapsed,
  onToggleCollapsed,
  headerAction,
  children
}: {
  /** Identity for React keys, the collapsed set and the test id suffix. For an agent column this
   *  is the bare agent id, so this refactor left the existing test ids byte-identical. */
  columnKey: string
  /** Why it can be overridden: a site and an agent can share a name — the registry's Kimi site and
   *  the Kimi CLI agent are both `'kimi'` — so a site column states its own prefix rather than
   *  emitting the same test id as that agent's column. */
  testIdPrefix?: string
  label: string
  count: number
  icon: React.ReactNode
  /** The rail's larger glyph; defaults to `icon`. */
  railIcon?: React.ReactNode
  collapsed: boolean
  onToggleCollapsed: () => void
  /** The column's own header control, for the site columns' "new conversation". */
  headerAction?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={onToggleCollapsed}
        title={label}
        aria-expanded={false}
        data-testid={`${testIdPrefix}-collapsed-${columnKey}`}
        className={cn(
          RAIL_WIDTH_CLASS,
          'flex shrink-0 flex-col items-center gap-2 rounded-xl border border-border/60 bg-muted/30 py-3',
          'text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'
        )}
      >
        <ChevronRight className="size-3.5 shrink-0" />
        {railIcon ?? icon}
        <span className="rounded-full bg-background px-1.5 text-2xs tabular-nums">{count}</span>
      </button>
    )
  }

  return (
    <section
      data-testid={`${testIdPrefix}-${columnKey}`}
      aria-label={translate('sessionsBoard.column.ariaLabel', '{{label}} sessions: {{count}}', {
        label,
        count
      })}
      className="flex min-w-[264px] flex-1 flex-col rounded-xl border border-border/60 bg-muted/30"
    >
      <header className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={onToggleCollapsed}
          aria-expanded
          className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
        >
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          {icon}
          <span className="truncate text-2xs font-semibold uppercase tracking-[0.05em] text-muted-foreground">
            {label}
          </span>
        </button>
        <span className="shrink-0 rounded-full bg-background px-1.5 text-2xs tabular-nums text-muted-foreground">
          {count}
        </span>
        {headerAction}
      </header>
      <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {children}
      </div>
    </section>
  )
}

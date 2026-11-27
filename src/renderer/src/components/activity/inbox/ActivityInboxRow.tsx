import React from 'react'
import { useNow } from '@/lib/window-activity/use-now'
import { formatShortTimeAgo } from '@/lib/time-format/short-time-ago'
import { useIntlLocale } from '@/i18n/use-translate'
import { formatAbsoluteDate } from '../threads/activity-thread-presentation'

/**
 * One inbox row, for an agent, a bot or an access request: who, when, what they need or did, and where. The whole
 * row opens it where you'd answer it; no row acts inline.
 */
export function ActivityInboxRow({
  avatar,
  title,
  timestamp,
  line,
  contextIcon,
  context,
  badge,
  selected,
  onOpen
}: {
  avatar: React.ReactNode
  title: string
  timestamp?: number
  /** Body text for every row: the whole inbox is what needs you, so no row needs a colour to say so. */
  line: string | null
  contextIcon: React.ReactNode
  context: React.ReactNode
  /** A short tag by the time, for a row that stays until you act on it, unlike the read-once rest. */
  badge?: string
  /** The row you have open: drawn like the selected workspace card. */
  selected: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <li className="pb-0.5">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        data-worktree-card-surface="true"
        data-worktree-card-active={selected ? 'primary' : undefined}
        className="group relative flex w-full flex-col gap-1 rounded-lg border border-transparent px-1.5 py-1.5 text-left outline-none worktree-sidebar-card-hover focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <span className="flex min-w-0 items-start gap-1.5">
          <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center">
            {avatar}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex min-w-0 items-start gap-2">
              <span className="block min-w-0 flex-1 truncate text-[13px] font-semibold leading-5 text-foreground">
                {title}
              </span>
              {badge ? (
                <span className="mt-0.5 shrink-0 rounded-sm border border-border px-1 text-[10px] font-medium leading-4 text-muted-foreground">
                  {badge}
                </span>
              ) : null}
              {timestamp === undefined ? null : <RowTime timestamp={timestamp} />}
            </span>
            {line ? (
              <span className="line-clamp-2 min-w-0 break-words text-[13px] leading-5 text-foreground/80">
                {line}
              </span>
            ) : null}
            <span className="flex min-w-0 items-center gap-1.5 pt-0.5 text-[11px] text-muted-foreground">
              <span className="inline-flex shrink-0 items-center">{contextIcon}</span>
              <span className="truncate">{context}</span>
            </span>
          </span>
        </span>
      </button>
    </li>
  )
}

/** How long until `at`, as compact as row times (`5m`, `3h`, `2d`), on the same 30s clock. */
export function RowTimeLeft({
  at,
  children
}: {
  at: number
  children: (left: string) => React.ReactNode
}): React.JSX.Element {
  const now = useNow(30_000)
  // Under a minute still reads as one: "now" would say it already expired.
  return <>{children(formatShortTimeAgo(now, Math.max(at, now + 60_000)))}</>
}

// Plain text, not EventTime's button: the whole row is the button, and buttons can't nest.
function RowTime({ timestamp }: { timestamp: number }): React.JSX.Element {
  const intlLocale = useIntlLocale()
  // Refresh only this leaf, on the same visibility-gated 30s clock as Activity rows.
  const now = useNow(30_000)
  return (
    <time
      dateTime={new Date(timestamp).toISOString()}
      title={formatAbsoluteDate(timestamp, intlLocale)}
      className="shrink-0 whitespace-nowrap py-0.5 text-xs font-medium tabular-nums text-foreground/60"
    >
      {formatShortTimeAgo(timestamp, now)}
    </time>
  )
}

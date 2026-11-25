import { cn } from '@/lib/class-names'
import { translate } from '@/i18n/i18n'
import { AttentionDot } from './AttentionDot'

/** "Workers · 2 running"; with none running, just "Workers". */
export function workersHeading(running: number): string {
  const heading = translate('bots.activity.workers', 'Workers')
  return running === 0
    ? heading
    : `${heading} · ${translate('bots.activity.running', '{{value0}} running', { value0: running })}`
}

export function ActivitySection({
  title,
  count,
  icon,
  action,
  className,
  ref,
  children
}: {
  title: string
  /** How many rows count, after the title; none for 0 or absent. */
  count?: number
  /** A glyph before the title, shared with where the sidebar points here. */
  icon?: React.ReactNode
  /** A control at the heading's end, such as a button that adds a row. */
  action?: React.ReactNode
  className?: string
  ref?: React.Ref<HTMLElement>
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section ref={ref} className={cn('flex flex-col gap-0.5', className)}>
      <div className="flex items-center justify-between gap-2 pb-1 pr-1">
        <h3 className="flex items-center gap-1 px-2 text-xs font-medium text-muted-foreground">
          {icon}
          {title}
          {count ? (
            <span aria-hidden className="font-normal tabular-nums">
              {count}
            </span>
          ) : null}
        </h3>
        {action}
      </div>
      {children}
    </section>
  )
}

/** One row of a bot's panel: an icon, a title and a detail line; a click opens what it names. */
export function ActivityRow({
  icon,
  title,
  detail,
  note,
  alert,
  aside,
  onOpen
}: {
  icon: React.ReactNode
  title: string
  detail: string
  /** Short status at the title line's end, so the detail keeps the full width. */
  aside?: React.ReactNode
  /** A quiet warning under the detail, marked with a dot. */
  note?: string
  alert?: string
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="flex w-full min-w-0 items-start gap-2 rounded-sm px-2 py-1.5 text-left enabled:cursor-pointer hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:hover:bg-transparent"
      disabled={!onOpen}
      onClick={onOpen}
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        {aside ? (
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
              {title}
            </span>
            {aside}
          </span>
        ) : (
          <span className="block truncate text-[13px] font-medium text-foreground">{title}</span>
        )}
        <span className="block truncate text-2xs text-muted-foreground">{detail}</span>
        {note ? (
          <span className="flex items-center gap-1.5 text-2xs text-muted-foreground">
            <AttentionDot />
            <span className="min-w-0 truncate">{note}</span>
          </span>
        ) : null}
        {alert ? <span className="block truncate text-2xs text-destructive">{alert}</span> : null}
      </span>
    </button>
  )
}

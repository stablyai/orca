// The Share dialog's building blocks: one line per part that drills in, and the items on its page.
import { ChevronLeft, ChevronRight, TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/class-names'

/** A line of the overview: a title and a quiet value; the whole line opens its page. */
export function BotShareRow({
  title,
  value,
  flag,
  trailing,
  onOpen
}: {
  title: string
  value?: React.ReactNode
  flag?: 'secret' | 'warning' | null
  trailing?: React.ReactNode
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <div
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (onOpen && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen()
        }
      }}
      className={cn(
        'flex min-h-11 items-center gap-2 rounded-md px-2.5 text-sm outline-none',
        onOpen && 'cursor-pointer hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring'
      )}
    >
      <span className="min-w-0 flex-1 font-medium">{title}</span>
      {flag ? <BotShareFlagIcon kind={flag} /> : null}
      {value ? (
        <span className="max-w-[45%] truncate text-xs text-muted-foreground">{value}</span>
      ) : null}
      {trailing ? (
        // A switch on the line acts on its own; it never opens the page.
        <span
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {trailing}
        </span>
      ) : null}
      {onOpen ? <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" /> : null}
    </div>
  )
}

/** An item on a part's page: an optional tick, its name and facts, and a page of its own. */
export function BotShareItem({
  lead,
  title,
  detail,
  note,
  off,
  trailing,
  onOpen
}: {
  lead?: React.ReactNode
  title: string
  detail?: React.ReactNode
  note?: React.ReactNode
  off?: boolean
  trailing?: React.ReactNode
  onOpen?: () => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md px-0 py-2 text-sm',
        off && 'text-muted-foreground',
        onOpen && 'cursor-pointer hover:bg-accent/40'
      )}
      onClick={onOpen}
    >
      {lead ? <span onClick={(event) => event.stopPropagation()}>{lead}</span> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate">{title}</div>
        {detail ? <div className="truncate text-xs text-muted-foreground">{detail}</div> : null}
        {note}
      </div>
      {trailing ? <span onClick={(event) => event.stopPropagation()}>{trailing}</span> : null}
      {onOpen ? (
        <button
          type="button"
          aria-label={title}
          className="rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <ChevronRight className="size-3.5 text-muted-foreground" />
        </button>
      ) : null}
    </div>
  )
}

export function BotShareFlagIcon({ kind }: { kind: 'secret' | 'warning' }): React.JSX.Element {
  return (
    <TriangleAlert
      className={cn(
        'size-3.5 shrink-0',
        kind === 'secret' ? 'text-destructive' : 'text-status-warning-text'
      )}
    />
  )
}

/** "Secret on line 6", under an item or a file. */
export function BotShareFlagNote({
  kind,
  children
}: {
  kind: 'secret' | 'warning'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'mt-1 flex items-center gap-1.5 text-xs',
        kind === 'secret' ? 'text-destructive' : 'text-status-warning-text'
      )}
    >
      <TriangleAlert className="size-3 shrink-0" />
      {children}
    </div>
  )
}

/** The back arrow at the top of a page, named for the page it returns to. */
export function BotShareBack({
  label,
  onBack
}: {
  label: string
  onBack: () => void
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1 rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      <ChevronLeft className="size-3.5" />
      {label}
    </button>
  )
}

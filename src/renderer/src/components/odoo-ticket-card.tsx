import { CalendarClock } from 'lucide-react'

import { OdooUserAvatar } from '@/components/odoo-user-avatar'
import {
  ODOO_CUSTOMER_BADGE_CLASS,
  odooColorBadgeClass,
  odooDeadlineBadgeClass
} from '@/components/odoo-badge-tones'
import { cn } from '@/lib/utils'
import { getIntlLocale } from '@/i18n/i18n'
import type { OdooTicket } from '../../../shared/odoo-types'
const PRIORITY_TONES: Record<string, string> = {
  '0': 'bg-muted-foreground/40',
  '1': 'bg-sky-500/80',
  '2': 'bg-amber-500/80',
  '3': 'bg-red-500/80'
}

function formatDeadline(deadline: string): string {
  // The app language, not the host locale, so the date matches the rest of the card.
  return new Date(deadline).toLocaleDateString(getIntlLocale(), {
    month: 'short',
    day: 'numeric'
  })
}

/**
 * One ticket on the kanban board. Mirrors an Odoo `project.task` kanban card:
 * ref + title, project/customer context, tags, deadline, assignee stack, and a
 * priority dot.
 */
export function OdooTicketCard({
  onOpen,
  selected,
  showInstanceContext,
  ticket
}: {
  onOpen: (ticket: OdooTicket) => void
  selected: boolean
  showInstanceContext: boolean
  ticket: OdooTicket
}): React.JSX.Element {
  const contextLabel = [showInstanceContext ? ticket.instanceName : null, ticket.project?.name]
    .filter(Boolean)
    .join(' / ')
  const badgeBase =
    'inline-flex items-center gap-0.5 rounded-full border px-1.5 py-0 text-[10px] font-medium'
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      onClick={() => onOpen(ticket)}
      className={cn(
        'flex w-full flex-col gap-1.5 rounded-lg border p-2.5 text-left transition-colors',
        selected
          ? 'border-border bg-accent/50'
          : 'border-border/60 bg-card hover:border-border hover:bg-accent/40'
      )}
    >
      <div className="flex w-full items-start gap-1.5">
        <span
          aria-hidden
          className={cn(
            'mt-1 size-2 shrink-0 rounded-full',
            PRIORITY_TONES[ticket.priority] ?? PRIORITY_TONES['0']
          )}
        />
        <span className="min-w-0 flex-1 line-clamp-2 text-xs leading-snug text-foreground">
          {ticket.title}
        </span>
      </div>

      <div className="flex w-full items-center gap-1.5 text-[10px] text-muted-foreground">
        <span className="shrink-0 tabular-nums">{ticket.ref}</span>
        {contextLabel ? <span className="min-w-0 truncate">{contextLabel}</span> : null}
      </div>

      {ticket.customer || ticket.deadline || ticket.tags.length > 0 ? (
        <div className="flex w-full flex-wrap items-center gap-1">
          {ticket.customer ? (
            <span className={cn(badgeBase, 'max-w-[130px] truncate', ODOO_CUSTOMER_BADGE_CLASS)}>
              {ticket.customer.name}
            </span>
          ) : null}
          {ticket.deadline ? (
            <span className={cn(badgeBase, odooDeadlineBadgeClass(ticket.deadline))}>
              <CalendarClock className="size-2.5" />
              {formatDeadline(ticket.deadline)}
            </span>
          ) : null}
          {ticket.tags.slice(0, 3).map((tag) => (
            <span
              key={tag.id}
              className={cn(badgeBase, 'max-w-[100px] truncate', odooColorBadgeClass(tag.color))}
            >
              {tag.name}
            </span>
          ))}
        </div>
      ) : null}

      {ticket.assignees.length > 0 ? (
        <div className="flex w-full items-center">
          <div className="flex -space-x-1.5">
            {ticket.assignees.slice(0, 4).map((user) => (
              <OdooUserAvatar key={user.id} user={user} className="size-5 ring-1 ring-background" />
            ))}
            {ticket.assignees.length > 4 ? (
              <span className="flex size-5 items-center justify-center rounded-full border border-border/50 bg-muted/60 text-[9px] text-muted-foreground ring-1 ring-background">
                +{ticket.assignees.length - 4}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </button>
  )
}

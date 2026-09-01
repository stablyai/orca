import { CalendarClock } from 'lucide-react'

import { OdooUserAvatar } from '@/components/odoo-user-avatar'
import {
  ODOO_CUSTOMER_BADGE_CLASS,
  odooColorBadgeClass,
  odooDeadlineBadgeClass,
  odooStageBadgeClass
} from '@/components/odoo-badge-tones'
import { cn } from '@/lib/utils'
import type { OdooTicket } from '../../../shared/odoo-types'
const PRIORITY_TONES: Record<string, string> = {
  '0': 'bg-muted-foreground/40',
  '1': 'bg-sky-500/80',
  '2': 'bg-amber-500/80',
  '3': 'bg-red-500/80'
}

function formatUpdatedAt(updatedAt: string): string {
  const elapsed = Date.now() - new Date(updatedAt).getTime()
  const minutes = Math.round(elapsed / 60_000)
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m`
  }
  const hours = Math.round(minutes / 60)
  if (hours < 24) {
    return `${hours}h`
  }
  return `${Math.round(hours / 24)}d`
}

function formatDeadline(deadline: string): string {
  return new Date(deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function OdooTicketRow({
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
    <div
      role="button"
      tabIndex={0}
      aria-current={selected ? 'true' : undefined}
      onClick={() => onOpen(ticket)}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onOpen(ticket)
        }
      }}
      className={cn(
        'flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left transition hover:bg-muted/50',
        selected && 'bg-muted/60'
      )}
    >
      <span
        aria-hidden
        className={cn(
          'mt-1.5 size-2 shrink-0 rounded-full',
          PRIORITY_TONES[ticket.priority] ?? PRIORITY_TONES['0']
        )}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1 truncate text-sm text-foreground">{ticket.title}</div>
          {ticket.assignees.length > 0 ? (
            <div className="flex shrink-0 -space-x-1.5">
              {ticket.assignees.slice(0, 3).map((user) => (
                <OdooUserAvatar
                  key={user.id}
                  user={user}
                  className="size-5 ring-1 ring-background"
                />
              ))}
              {ticket.assignees.length > 3 ? (
                <span className="flex size-5 items-center justify-center rounded-full border border-border/50 bg-muted/60 text-[9px] text-muted-foreground ring-1 ring-background">
                  +{ticket.assignees.length - 3}
                </span>
              ) : null}
            </div>
          ) : null}
          <span className="w-8 shrink-0 text-right text-[11px] text-muted-foreground">
            {formatUpdatedAt(ticket.updatedAt)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="shrink-0">{ticket.ref}</span>
          {contextLabel ? <span className="max-w-[150px] truncate">{contextLabel}</span> : null}
          {ticket.stage ? (
            <span className={cn(badgeBase, odooStageBadgeClass(ticket.stage))}>
              {ticket.stage.name}
            </span>
          ) : null}
          {ticket.customer ? (
            <span className={cn(badgeBase, 'max-w-[120px] truncate', ODOO_CUSTOMER_BADGE_CLASS)}>
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
      </div>
    </div>
  )
}

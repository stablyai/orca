import { OdooIcon } from '@/components/icons/OdooIcon'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { DashboardCardOdooTicket } from '../../../../shared/dashboard-snapshot'
import { translate } from '@/i18n/i18n'

/** Structural compare — the ticket arrives in a fresh clone on each publish. */
export function sameOdooTicket(
  a: DashboardCardOdooTicket | undefined,
  b: DashboardCardOdooTicket | undefined
): boolean {
  if (a === b) {
    return true
  }
  if (!a || !b) {
    return false
  }
  return a.id === b.id && a.title === b.title && a.url === b.url && a.instanceId === b.instanceId
}

/**
 * The Odoo ticket a workspace is linked to, shown on its board card. Opening
 * the ticket is a plain shell hop — the board has no Odoo store of its own,
 * and the pop-out renderer has no store at all.
 */
export function AgentKanbanCardOdooPill({
  ticket
}: {
  ticket: DashboardCardOdooTicket | undefined
}): React.JSX.Element | null {
  if (!ticket) {
    return null
  }
  const label = `#${ticket.id}`
  const pill = (
    <span className="inline-flex min-w-0 shrink items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-1.5 py-px text-[10px] leading-none text-violet-700 dark:text-violet-300">
      <OdooIcon className="size-2.5 shrink-0" aria-hidden />
      <span className="shrink-0 tabular-nums">{label}</span>
      {ticket.title ? <span className="min-w-0 truncate">{ticket.title}</span> : null}
    </span>
  )
  if (!ticket.url) {
    return pill
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          // Stops the click from also opening the card's terminal dialog.
          onClick={(event) => {
            event.stopPropagation()
            window.api.shell.openUrl(ticket.url as string)
          }}
          aria-label={translate('dashboardPopout.card.odoo.open', 'Open Odoo ticket {{ref}}', {
            ref: label
          })}
          className="flex min-w-0 shrink focus-visible:rounded-full focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {pill}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {ticket.title ?? label}
      </TooltipContent>
    </Tooltip>
  )
}

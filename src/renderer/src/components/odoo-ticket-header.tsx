import { CalendarClock, ExternalLink, X } from 'lucide-react'

import { OdooTicketAssigneePicker } from '@/components/odoo-ticket-assignee-picker'
import { ODOO_TICKET_CONTROL_WIDTH_CLASS } from '@/components/odoo-ticket-control-width'
import { OdooTicketStartWorkspaceButton } from '@/components/odoo-ticket-start-workspace-button'
import {
  ODOO_CUSTOMER_BADGE_CLASS,
  odooColorBadgeClass,
  odooDeadlineBadgeClass,
  odooStageBadgeClass
} from '@/components/odoo-badge-tones'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  OdooPriority,
  OdooStage,
  OdooTicket,
  OdooTicketUpdate
} from '../../../shared/odoo-types'
function getPriorityOptions(): { id: OdooPriority; label: string }[] {
  return [
    { id: '0', label: translate('auto.components.odoo.ticket.workspace.4411a54695', 'Low') },
    { id: '1', label: translate('auto.components.odoo.ticket.workspace.bcaea799c1', 'Medium') },
    { id: '2', label: translate('auto.components.odoo.ticket.workspace.2f1f13a17c', 'High') },
    { id: '3', label: translate('auto.components.odoo.ticket.workspace.1000c20873', 'Urgent') }
  ]
}

function formatDeadline(deadline: string): string {
  return new Date(deadline).toLocaleDateString(undefined, { dateStyle: 'medium' })
}

export function OdooTicketHeader({
  ticket,
  stages,
  saving,
  onClose,
  applyUpdate
}: {
  ticket: OdooTicket
  stages: OdooStage[]
  saving: boolean
  onClose: () => void
  applyUpdate: (updates: OdooTicketUpdate, patch: Partial<OdooTicket>) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-none flex-col gap-3 border-b border-border/50 px-5 py-4">
      <div className="flex items-center gap-2 pr-4">
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          title={translate('auto.components.ui.sheet.1189e9fe0a', 'Close')}
          aria-label={translate('auto.components.ui.sheet.1189e9fe0a', 'Close')}
          onClick={onClose}
        >
          <X className="size-5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
          title={translate('auto.components.odoo.ticket.workspace.2c5256318d', 'Open in Odoo')}
          aria-label={translate('auto.components.odoo.ticket.workspace.2c5256318d', 'Open in Odoo')}
          onClick={() => window.api.shell.openUrl(ticket.url)}
        >
          <ExternalLink className="size-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] text-muted-foreground">
            {[ticket.ref, ticket.project?.name].filter(Boolean).join(' · ')}
          </div>
          <h2 className="mt-0.5 text-base font-semibold leading-snug text-foreground">
            {ticket.title}
          </h2>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {stages.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-muted-foreground">
              {translate('auto.components.odoo.ticket.workspace.8229d636d2', 'Stage')}
            </span>
            <Select
              value={ticket.stage ? String(ticket.stage.id) : undefined}
              disabled={saving}
              onValueChange={(value) => {
                const stage = stages.find((entry) => String(entry.id) === value)
                if (stage && stage.id !== ticket.stage?.id) {
                  applyUpdate({ stageId: stage.id }, { stage })
                }
              }}
            >
              <SelectTrigger className={cn('h-7 text-xs', ODOO_TICKET_CONTROL_WIDTH_CLASS)}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {stages.map((stage) => (
                  <SelectItem key={stage.id} value={String(stage.id)}>
                    <span className="flex items-center gap-1.5">
                      <span
                        className={cn('size-2 rounded-full border', odooStageBadgeClass(stage))}
                      />
                      {stage.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.odoo.ticket.workspace.9809e7ba90', 'Priority')}
          </span>
          <Select
            value={ticket.priority}
            disabled={saving}
            onValueChange={(value) => {
              const priority = value as OdooPriority
              if (priority !== ticket.priority) {
                applyUpdate({ priority }, { priority })
              }
            }}
          >
            <SelectTrigger className={cn('h-7 text-xs', ODOO_TICKET_CONTROL_WIDTH_CLASS)}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {getPriorityOptions().map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-muted-foreground">
            {translate('auto.components.odoo.ticket.workspace.4f1a1c9e6c', 'Assignees')}
          </span>
          <OdooTicketAssigneePicker
            ticket={ticket}
            saving={saving}
            onChange={(assignees) =>
              applyUpdate({ assigneeIds: assignees.map((user) => user.id) }, { assignees })
            }
          />
        </div>
        {/* Sits on the metadata row rather than the title row: the panel's top
            band overlaps the titlebar drag strip, where a button reads as
            floating in the window chrome. */}
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 pl-2">
          <OdooTicketStartWorkspaceButton ticket={ticket} />
        </div>
      </div>
      {ticket.customer || ticket.deadline || ticket.tags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          {ticket.customer ? (
            <span
              className={cn(
                'inline-flex max-w-[220px] items-center gap-1 truncate rounded-full border px-2 py-0.5 text-[11px] font-medium',
                ODOO_CUSTOMER_BADGE_CLASS
              )}
            >
              {translate('auto.components.odoo.ticket.header.4d59a1b53f', 'Customer')}:{' '}
              <span className="truncate">{ticket.customer.name}</span>
            </span>
          ) : null}
          {ticket.deadline ? (
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
                odooDeadlineBadgeClass(ticket.deadline)
              )}
            >
              <CalendarClock className="size-3" />
              {formatDeadline(ticket.deadline)}
            </span>
          ) : null}
          {ticket.tags.map((tag) => (
            <span
              key={tag.id}
              className={cn(
                'inline-flex max-w-[160px] items-center truncate rounded-full border px-2 py-0.5 text-[11px] font-medium',
                odooColorBadgeClass(tag.color)
              )}
            >
              {tag.name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  )
}

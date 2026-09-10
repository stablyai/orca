import React, { useMemo } from 'react'

import { OdooTicketCard } from '@/components/odoo-ticket-card'
import {
  deriveOdooTicketStageColumns,
  type OdooTicketStageColumn
} from '@/components/odoo-ticket-stage-columns'
import { odooStageBadgeClass } from '@/components/odoo-badge-tones'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { OdooTicket } from '../../../shared/odoo-types'
/**
 * Stable DOM id for a stage column's ticket-count pill, so it can be targeted.
 * Instance ids are base64url, so the result stays a valid id.
 */
export function odooStageCountElementId(column: OdooTicketStageColumn): string {
  const stage = column.stageId === null ? 'no-stage' : String(column.stageId)
  return column.instanceId
    ? `odoo-stage-count-${column.instanceId}-${stage}`
    : `odoo-stage-count-${stage}`
}

function columnLabel(column: OdooTicketStageColumn): string {
  return column.stageId === null
    ? translate('auto.components.odoo.ticket.kanban.7f463f2d0d', 'No stage')
    : column.name
}

function StageColumn({
  column,
  selectedTicketId,
  selectedInstanceId,
  showInstanceContext,
  onOpen
}: {
  column: OdooTicketStageColumn
  selectedTicketId: number | null
  selectedInstanceId: string | null
  showInstanceContext: boolean
  onOpen: (ticket: OdooTicket) => void
}): React.JSX.Element {
  // The count pill borrows the column's own stage tone so the board reads as a
  // colour code rather than a row of identical grey chips.
  const tone =
    column.stageId === null
      ? 'border-border/60 bg-muted/50 text-muted-foreground'
      : odooStageBadgeClass({
          id: column.stageId,
          ...(column.color !== undefined ? { color: column.color } : {})
        })
  return (
    <section className="flex min-w-[248px] flex-1 flex-col rounded-xl border border-border/60 bg-muted/30">
      <header className="flex flex-none items-center gap-2 px-3 py-2">
        {column.stageId !== null ? (
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full border', tone)} />
        ) : null}
        <span className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.05em] text-muted-foreground">
          {columnLabel(column)}
        </span>
        <span
          id={odooStageCountElementId(column)}
          data-odoo-stage-count={column.tickets.length}
          data-odoo-stage-key={column.key}
          className={cn(
            'ml-auto inline-flex shrink-0 items-center justify-center rounded-full border px-1.5 py-0.5 text-[11px] font-semibold leading-none tabular-nums',
            tone
          )}
        >
          {column.tickets.length}
        </span>
      </header>
      <div className="scrollbar-sleek flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2">
        {column.tickets.map((ticket) => (
          <OdooTicketCard
            key={`${ticket.instanceId ?? ''}:${ticket.id}`}
            ticket={ticket}
            // Ticket ids repeat across instances, so identity is the pair.
            selected={
              selectedTicketId === ticket.id && selectedInstanceId === (ticket.instanceId ?? null)
            }
            showInstanceContext={showInstanceContext}
            onOpen={onOpen}
          />
        ))}
      </div>
    </section>
  )
}

/** Stage columns over the loaded ticket set — the kanban half of the panel. */
export function OdooTicketKanban({
  tickets,
  selectedTicketId,
  selectedInstanceId,
  showInstanceContext,
  onOpen
}: {
  tickets: OdooTicket[]
  selectedTicketId: number | null
  selectedInstanceId: string | null
  showInstanceContext: boolean
  onOpen: (ticket: OdooTicket) => void
}): React.JSX.Element {
  const columns = useMemo(() => deriveOdooTicketStageColumns(tickets), [tickets])
  return (
    <div className="scrollbar-sleek flex min-h-0 flex-1 overflow-x-auto p-3">
      <div className="flex w-full gap-3">
        {columns.map((column) => (
          <StageColumn
            key={column.key}
            column={column}
            selectedTicketId={selectedTicketId}
            selectedInstanceId={selectedInstanceId}
            showInstanceContext={showInstanceContext}
            onOpen={onOpen}
          />
        ))}
      </div>
    </div>
  )
}

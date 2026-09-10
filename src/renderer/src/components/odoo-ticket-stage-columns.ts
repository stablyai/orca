import type { OdooTicket } from '../../../shared/odoo-types'
/** Stage slot for tickets carrying no stage (private todos, for instance). */
export const ODOO_NO_STAGE_COLUMN = '__no_stage__'

export type OdooTicketStageColumn = {
  /**
   * Unique across instances. Odoo stage ids are per-database and the panel can
   * show several instances at once, so two unrelated stages would otherwise
   * collapse into one column.
   */
  key: string
  /** Instance the column's stage belongs to, or null for a local-only ticket set. */
  instanceId: string | null
  /** Raw Odoo stage id, or null for the stage-less column. */
  stageId: number | null
  name: string
  sequence: number
  fold: boolean
  color?: number
  tickets: OdooTicket[]
}

function columnKey(instanceId: string | null, stageId: number | null): string {
  return `${instanceId ?? ''}:${stageId === null ? ODOO_NO_STAGE_COLUMN : stageId}`
}

/**
 * Groups the loaded tickets into kanban columns.
 *
 * Columns follow Odoo's own `project.task.type.sequence` rather than the
 * alphabetical facet order, so the board reads left-to-right like the Odoo
 * kanban it mirrors. Only stages present in the loaded set become columns —
 * the panel never fetches the full stage list for a mixed-project view.
 */
export function deriveOdooTicketStageColumns(tickets: OdooTicket[]): OdooTicketStageColumn[] {
  const columns = new Map<string, OdooTicketStageColumn>()
  for (const ticket of tickets) {
    const stage = ticket.stage
    const instanceId = ticket.instanceId ?? null
    const stageId = stage?.id ?? null
    const key = columnKey(instanceId, stageId)
    const existing = columns.get(key)
    if (existing) {
      existing.tickets.push(ticket)
      continue
    }
    columns.set(key, {
      key,
      instanceId,
      stageId,
      name: stage?.name ?? '',
      // Unstaged tickets sort last: Odoo has no sequence to honour for them.
      sequence: stage?.sequence ?? Number.MAX_SAFE_INTEGER,
      fold: stage?.fold ?? false,
      ...(stage?.color !== undefined ? { color: stage.color } : {}),
      tickets: [ticket]
    })
  }
  return [...columns.values()].sort(
    (a, b) =>
      a.sequence - b.sequence ||
      a.name.localeCompare(b.name) ||
      // Same-named stages from different instances still need a stable order.
      (a.instanceId ?? '').localeCompare(b.instanceId ?? '')
  )
}

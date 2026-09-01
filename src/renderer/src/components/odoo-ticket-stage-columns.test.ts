import { describe, expect, it } from 'vitest'

import { deriveOdooTicketStageColumns, ODOO_NO_STAGE_COLUMN } from './odoo-ticket-stage-columns'
import type { OdooTicket } from '../../../shared/odoo-types'
function ticket(id: number, stage?: OdooTicket['stage'], instanceId?: string): OdooTicket {
  return {
    id,
    ref: `#${id}`,
    title: `Ticket ${id}`,
    url: `https://odoo.example/${id}`,
    state: '01_in_progress',
    priority: '0',
    tags: [],
    assignees: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...(stage ? { stage } : {}),
    ...(instanceId ? { instanceId } : {})
  }
}

const doing = { id: 2, name: 'Doing', sequence: 10, fold: false }
const backlog = { id: 1, name: 'Backlog', sequence: 1, fold: false }

describe('deriveOdooTicketStageColumns', () => {
  it('orders columns by Odoo stage sequence, not alphabetically', () => {
    const columns = deriveOdooTicketStageColumns([ticket(1, doing), ticket(2, backlog)])
    expect(columns.map((column) => column.name)).toEqual(['Backlog', 'Doing'])
  })

  it('groups every ticket of a stage into one column', () => {
    const columns = deriveOdooTicketStageColumns([
      ticket(1, doing),
      ticket(2, doing),
      ticket(3, backlog)
    ])
    expect(columns.map((column) => column.tickets.length)).toEqual([1, 2])
  })

  it('collects stage-less tickets into a trailing column', () => {
    const columns = deriveOdooTicketStageColumns([ticket(1), ticket(2, backlog)])
    expect(columns.map((column) => column.stageId)).toEqual([1, null])
    expect(columns[1].key).toContain(ODOO_NO_STAGE_COLUMN)
  })

  it('carries the stage colour and fold flag through', () => {
    const columns = deriveOdooTicketStageColumns([
      ticket(1, { id: 7, name: 'Done', sequence: 99, fold: true, color: 10 })
    ])
    expect(columns[0]).toMatchObject({ stageId: 7, fold: true, color: 10 })
  })

  it('keeps same-id stages from different instances apart', () => {
    const columns = deriveOdooTicketStageColumns([
      ticket(1, { id: 3, name: 'Doing', sequence: 10, fold: false }, 'instance-a'),
      ticket(1, { id: 3, name: 'Triage', sequence: 10, fold: false }, 'instance-b')
    ])
    expect(columns.map((column) => column.instanceId)).toEqual(['instance-a', 'instance-b'])
    expect(new Set(columns.map((column) => column.key)).size).toBe(2)
    expect(columns.map((column) => column.tickets.length)).toEqual([1, 1])
  })

  it('returns nothing for an empty set', () => {
    expect(deriveOdooTicketStageColumns([])).toEqual([])
  })
})

import { describe, expect, it } from 'vitest'

import { deriveOdooTicketFacets, filterOdooTickets } from './odoo-ticket-facets'
import type { OdooTicket } from '../../../shared/odoo-types'
function ticket(overrides: Partial<OdooTicket>): OdooTicket {
  return {
    id: 1,
    ref: '#1',
    title: 'Ticket',
    url: 'https://odoo.example/1',
    state: '01_in_progress',
    priority: '0',
    tags: [],
    assignees: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

describe('deriveOdooTicketFacets', () => {
  it('collects unique, alphabetically sorted stages/assignees/tags', () => {
    const tickets = [
      ticket({
        id: 1,
        stage: { id: 2, name: 'Doing', sequence: 1, fold: false },
        assignees: [{ id: 5, displayName: 'Zoe' }],
        tags: [{ id: 9, name: 'urgent' }]
      }),
      ticket({
        id: 2,
        stage: { id: 1, name: 'Backlog', sequence: 0, fold: false },
        assignees: [
          { id: 5, displayName: 'Zoe' },
          { id: 3, displayName: 'Ana' }
        ],
        tags: [{ id: 9, name: 'urgent' }]
      })
    ]
    const facets = deriveOdooTicketFacets(tickets)
    expect(facets.stages).toEqual(['Backlog', 'Doing'])
    expect(facets.assignees).toEqual([
      { id: 3, label: 'Ana' },
      { id: 5, label: 'Zoe' }
    ])
    expect(facets.tags).toEqual([{ id: 9, label: 'urgent' }])
  })
})

describe('filterOdooTickets', () => {
  const tickets = [
    ticket({ id: 1, priority: '3', assignees: [{ id: 5, displayName: 'Zoe' }], tags: [] }),
    ticket({ id: 2, priority: '0', assignees: [], tags: [{ id: 9, name: 'urgent' }] })
  ]

  it("returns everything when all facets are 'all'", () => {
    const result = filterOdooTickets(tickets, {
      stages: [],
      priority: 'all',
      assignee: 'all',
      tag: 'all'
    })
    expect(result.map((t) => t.id)).toEqual([1, 2])
  })

  it('matches assignee id as a string', () => {
    const result = filterOdooTickets(tickets, {
      stages: [],
      priority: 'all',
      assignee: '5',
      tag: 'all'
    })
    expect(result.map((t) => t.id)).toEqual([1])
  })

  it('matches tag id as a string', () => {
    const result = filterOdooTickets(tickets, {
      stages: [],
      priority: 'all',
      assignee: 'all',
      tag: '9'
    })
    expect(result.map((t) => t.id)).toEqual([2])
  })

  it('unions several stages and keeps other facets a conjunction', () => {
    const staged = [
      ticket({ id: 1, stage: { id: 1, name: 'Backlog', sequence: 0, fold: false } }),
      ticket({ id: 2, stage: { id: 2, name: 'Doing', sequence: 1, fold: false } }),
      ticket({ id: 3, stage: { id: 3, name: 'Done', sequence: 2, fold: false } })
    ]
    const result = filterOdooTickets(staged, {
      stages: ['Backlog', 'Done'],
      priority: 'all',
      assignee: 'all',
      tag: 'all'
    })
    expect(result.map((t) => t.id)).toEqual([1, 3])
  })

  it('excludes stage-less tickets once any stage is selected', () => {
    const result = filterOdooTickets([ticket({ id: 9 })], {
      stages: ['Backlog'],
      priority: 'all',
      assignee: 'all',
      tag: 'all'
    })
    expect(result).toEqual([])
  })

  it('matches tickets nobody owns on the unassigned sentinel', () => {
    const result = filterOdooTickets(tickets, {
      stages: [],
      priority: 'all',
      assignee: 'unassigned',
      tag: 'all'
    })
    expect(result.map((t) => t.id)).toEqual([2])
  })

  it('combines facets as a conjunction', () => {
    const result = filterOdooTickets(tickets, {
      stages: [],
      priority: '3',
      assignee: '5',
      tag: 'all'
    })
    expect(result.map((t) => t.id)).toEqual([1])
  })
})

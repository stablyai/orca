import { describe, expect, it } from 'vitest'

import {
  DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA,
  matchesOdooAutoWorkspaceCriteria,
  selectOdooAutoWorkspaceCandidates
} from './odoo-auto-workspace-criteria'
import type { OdooTicket } from '../../../shared/odoo-types'
const NOW = Date.parse('2026-08-13T12:00:00Z')

function ticket(overrides: Partial<OdooTicket> = {}): OdooTicket {
  return {
    id: 42,
    ref: '#42',
    title: 'Fix login bug',
    url: 'https://odoo.example.com/odoo/project/42',
    state: '01_in_progress',
    priority: '1',
    tags: [],
    assignees: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides
  }
}

const ANY = { ...DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA, assignedToMe: false }

describe('matchesOdooAutoWorkspaceCriteria', () => {
  it('matches a ticket assigned to the viewer', () => {
    const entry = ticket({ assignees: [{ id: 7, displayName: 'Theo' }] })
    expect(
      matchesOdooAutoWorkspaceCriteria(entry, DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA, {
        viewerUid: 7,
        now: NOW
      })
    ).toBe(true)
  })

  it('refuses rather than widening when the viewer is unknown', () => {
    const entry = ticket({ assignees: [{ id: 7, displayName: 'Theo' }] })
    expect(
      matchesOdooAutoWorkspaceCriteria(entry, DEFAULT_ODOO_AUTO_WORKSPACE_CRITERIA, {
        viewerUid: undefined,
        now: NOW
      })
    ).toBe(false)
  })

  it('filters on priority', () => {
    const criteria = { ...ANY, priorities: ['3' as const] }
    expect(
      matchesOdooAutoWorkspaceCriteria(ticket({ priority: '3' }), criteria, {
        viewerUid: 7,
        now: NOW
      })
    ).toBe(true)
    expect(
      matchesOdooAutoWorkspaceCriteria(ticket({ priority: '1' }), criteria, {
        viewerUid: 7,
        now: NOW
      })
    ).toBe(false)
  })

  it('filters on stage', () => {
    const criteria = { ...ANY, stageIds: [3] }
    const staged = ticket({ stage: { id: 3, name: 'Doing', sequence: 1, fold: false } })
    expect(matchesOdooAutoWorkspaceCriteria(staged, criteria, { viewerUid: 7, now: NOW })).toBe(
      true
    )
    expect(matchesOdooAutoWorkspaceCriteria(ticket(), criteria, { viewerUid: 7, now: NOW })).toBe(
      false
    )
  })

  it('treats an overdue deadline as matching, not as expired', () => {
    const criteria = { ...ANY, deadlineWithinDays: 3 }
    const overdue = ticket({ deadline: '2026-08-01' })
    expect(matchesOdooAutoWorkspaceCriteria(overdue, criteria, { viewerUid: 7, now: NOW })).toBe(
      true
    )
  })

  it('rejects a deadline beyond the window, and a missing one', () => {
    const criteria = { ...ANY, deadlineWithinDays: 3 }
    expect(
      matchesOdooAutoWorkspaceCriteria(ticket({ deadline: '2026-09-30' }), criteria, {
        viewerUid: 7,
        now: NOW
      })
    ).toBe(false)
    expect(matchesOdooAutoWorkspaceCriteria(ticket(), criteria, { viewerUid: 7, now: NOW })).toBe(
      false
    )
  })

  it('can require a non-empty description', () => {
    const criteria = { ...ANY, requireDescription: true }
    expect(
      matchesOdooAutoWorkspaceCriteria(ticket({ description: '  ' }), criteria, {
        viewerUid: 7,
        now: NOW
      })
    ).toBe(false)
    expect(
      matchesOdooAutoWorkspaceCriteria(ticket({ description: 'steps' }), criteria, {
        viewerUid: 7,
        now: NOW
      })
    ).toBe(true)
  })
})

describe('selectOdooAutoWorkspaceCandidates', () => {
  const base = { viewerUid: 7, now: NOW, excludedTicketIds: new Set<number>(), maxPerRun: 2 }
  const tickets = [ticket({ id: 1 }), ticket({ id: 2 }), ticket({ id: 3 })]

  it('caps the run and reports what it dropped', () => {
    const result = selectOdooAutoWorkspaceCandidates(tickets, ANY, base)
    expect(result.selected.map((t) => t.id)).toEqual([1, 2])
    expect(result.droppedByCap).toBe(1)
  })

  it('never re-triggers a ticket that already has a workspace', () => {
    const result = selectOdooAutoWorkspaceCandidates(tickets, ANY, {
      ...base,
      excludedTicketIds: new Set([1, 2])
    })
    expect(result.selected.map((t) => t.id)).toEqual([3])
    expect(result.droppedByCap).toBe(0)
  })

  it('creates nothing when the cap is zero', () => {
    expect(selectOdooAutoWorkspaceCandidates(tickets, ANY, { ...base, maxPerRun: 0 })).toEqual({
      selected: [],
      droppedByCap: 0
    })
  })
})

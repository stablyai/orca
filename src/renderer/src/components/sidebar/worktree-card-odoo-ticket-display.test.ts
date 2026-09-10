import { describe, expect, it } from 'vitest'

import {
  getConfiguredWorktreeCardOdooTicketDisplay,
  getWorktreeCardOdooTicketDisplay
} from './worktree-card-odoo-ticket-display'
import type { OdooTicket } from '../../../../shared/odoo-types'

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

describe('getWorktreeCardOdooTicketDisplay', () => {
  it('returns null when the worktree links no ticket', () => {
    expect(getWorktreeCardOdooTicketDisplay({ linkedOdooTicket: null }, null)).toBeNull()
  })

  it('shows an id-only placeholder while the ticket is still loading', () => {
    const display = getWorktreeCardOdooTicketDisplay({ linkedOdooTicket: 42 }, null)
    expect(display?.ref).toBe('#42')
    expect(display?.url).toBeUndefined()
  })

  it('prefers the loaded ticket once it arrives', () => {
    const display = getWorktreeCardOdooTicketDisplay(
      { linkedOdooTicket: 42 },
      ticket({
        stage: { id: 3, name: 'In progress', sequence: 1, fold: false },
        tags: [{ id: 1, name: 'bug', color: 1 }]
      })
    )
    expect(display).toMatchObject({
      ref: '#42',
      title: 'Fix login bug',
      url: 'https://odoo.example.com/odoo/project/42',
      stageName: 'In progress',
      labels: ['bug']
    })
  })

  it('omits stage and labels the ticket does not carry', () => {
    const display = getWorktreeCardOdooTicketDisplay({ linkedOdooTicket: 42 }, ticket())
    expect(display).not.toHaveProperty('stageName')
    expect(display).not.toHaveProperty('labels')
  })
})

describe('getConfiguredWorktreeCardOdooTicketDisplay', () => {
  it('hides the badge when the card property is off', () => {
    expect(
      getConfiguredWorktreeCardOdooTicketDisplay({ linkedOdooTicket: 42 }, ticket(), ['jira-issue'])
    ).toBeNull()
  })

  it('shows the badge when the card property is on', () => {
    expect(
      getConfiguredWorktreeCardOdooTicketDisplay({ linkedOdooTicket: 42 }, ticket(), [
        'odoo-ticket'
      ])
    ).not.toBeNull()
  })
})

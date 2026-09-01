import { describe, expect, it } from 'vitest'

import { getOdooTicketWorkspaceSeed } from './odoo-ticket-workspace-seed'
import type { OdooTicket } from '../../../shared/odoo-types'
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

describe('getOdooTicketWorkspaceSeed', () => {
  it('combines the slugified ref and title', () => {
    expect(getOdooTicketWorkspaceSeed(ticket())).toBe('42-fix-login-bug')
  })

  it('slugifies a longer title with punctuation', () => {
    expect(
      getOdooTicketWorkspaceSeed(ticket({ ref: '#7', title: "Customer can't reset password" }))
    ).toBe('7-customer-cant-reset-password')
  })
})

import { describe, expect, it } from 'vitest'

import { deriveOdooWorktreeLinkFields } from './odoo-worktree-link-fields'

describe('deriveOdooWorktreeLinkFields', () => {
  it('derives the flat ticket/instance fields from an Odoo linked work item', () => {
    expect(
      deriveOdooWorktreeLinkFields({
        provider: 'odoo',
        number: 42,
        odooInstanceId: 'instance-1'
      })
    ).toEqual({ linkedOdooTicket: 42, linkedOdooInstanceId: 'instance-1' })
  })

  it('defaults the instance id to null when the linked item has none', () => {
    expect(deriveOdooWorktreeLinkFields({ provider: 'odoo', number: 7 })).toEqual({
      linkedOdooTicket: 7,
      linkedOdooInstanceId: null
    })
  })

  it('returns null for a non-Odoo linked work item', () => {
    expect(
      deriveOdooWorktreeLinkFields({ provider: 'github', number: 42, odooInstanceId: 'instance-1' })
    ).toBeNull()
  })

  it('returns null when there is no linked work item', () => {
    expect(deriveOdooWorktreeLinkFields(null)).toBeNull()
    expect(deriveOdooWorktreeLinkFields(undefined)).toBeNull()
  })
})

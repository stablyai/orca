import { describe, expect, it } from 'vitest'

import { resolveDashboardCardOdooTicket } from './dashboard-card-context'
import type { Worktree } from '../../../../shared/worktree/types'
function worktree(overrides: Partial<Worktree>): Worktree {
  return { ...(overrides as Worktree) }
}

describe('resolveDashboardCardOdooTicket', () => {
  it('returns nothing when the workspace links no ticket', () => {
    expect(resolveDashboardCardOdooTicket(worktree({}))).toBeUndefined()
    expect(resolveDashboardCardOdooTicket(worktree({ linkedOdooTicket: null }))).toBeUndefined()
    expect(resolveDashboardCardOdooTicket(worktree({ linkedOdooTicket: 0 }))).toBeUndefined()
  })

  it('badges the id alone when no cached work item exists', () => {
    expect(
      resolveDashboardCardOdooTicket(
        worktree({ linkedOdooTicket: 45514, linkedOdooInstanceId: 'prod' })
      )
    ).toEqual({ id: 45514, instanceId: 'prod' })
  })

  it('adds the cached title and url when they describe the linked ticket', () => {
    expect(
      resolveDashboardCardOdooTicket(
        worktree({
          linkedOdooTicket: 45514,
          linkedWorkItem: {
            provider: 'odoo',
            type: 'issue',
            number: 45514,
            title: 'Connecteur',
            url: 'https://odoo.example/45514',
            odooInstanceId: 'prod'
          }
        })
      )
    ).toEqual({
      id: 45514,
      title: 'Connecteur',
      url: 'https://odoo.example/45514',
      instanceId: 'prod'
    })
  })

  it('drops a cached title that describes a different ticket', () => {
    expect(
      resolveDashboardCardOdooTicket(
        worktree({
          linkedOdooTicket: 45514,
          linkedWorkItem: {
            provider: 'odoo',
            type: 'issue',
            number: 111,
            title: 'Stale',
            url: 'https://odoo.example/111'
          }
        })
      )
    ).toEqual({ id: 45514 })
  })

  it('ignores a work item from another provider', () => {
    expect(
      resolveDashboardCardOdooTicket(
        worktree({
          linkedWorkItem: {
            provider: 'github',
            type: 'pr',
            number: 42,
            title: 'PR',
            url: 'https://github.example/42'
          }
        })
      )
    ).toBeUndefined()
  })
})

import { describe, expect, it } from 'vitest'

import { bindTaskPageOdooItemSourceContext } from './task-page-odoo-item-source-context'
import type { OdooInstance, OdooTicket } from '../../../shared/odoo-types'
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

function instance(overrides: Partial<OdooInstance> = {}): OdooInstance {
  return {
    id: 'instance-1',
    serverUrl: 'https://odoo.example.com',
    database: 'prod',
    login: 'user@example.com',
    uid: 1,
    displayName: 'Prod Odoo',
    ...overrides
  }
}

describe('bindTaskPageOdooItemSourceContext', () => {
  it('binds the source context to the instance matching the ticket', () => {
    const context = bindTaskPageOdooItemSourceContext({
      ticket: ticket({ instanceId: 'instance-1', project: { id: 7, name: 'Support' } }),
      instances: [instance(), instance({ id: 'instance-2', database: 'staging' })],
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(context?.provider).toBe('odoo')
    expect(context?.providerIdentity).toMatchObject({
      provider: 'odoo',
      instanceId: 'instance-1',
      serverUrl: 'https://odoo.example.com',
      database: 'prod',
      projectId: 7
    })
  })

  it('falls back to the sole configured instance for legacy tickets without an instanceId', () => {
    const context = bindTaskPageOdooItemSourceContext({
      ticket: ticket(),
      instances: [instance()],
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(context?.providerIdentity).toMatchObject({ instanceId: 'instance-1' })
  })

  it('returns null when no instance matches and several are configured', () => {
    const context = bindTaskPageOdooItemSourceContext({
      ticket: ticket({ instanceId: 'unknown' }),
      instances: [instance(), instance({ id: 'instance-2' })],
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(context).toBeNull()
  })

  it('returns null when there is no configured instance', () => {
    const context = bindTaskPageOdooItemSourceContext({
      ticket: ticket(),
      instances: [],
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(context).toBeNull()
  })
})

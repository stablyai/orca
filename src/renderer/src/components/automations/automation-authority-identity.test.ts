import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import {
  automationAuthorityPartitionContext,
  automationRuntimePairingRevision,
  groupReposByAutomationAuthority
} from './automation-authority-identity'

function repo(overrides: Partial<Repo> & { id: string }): Repo {
  return {
    path: `/repos/${overrides.id}`,
    displayName: overrides.id,
    badgeColor: 'blue',
    addedAt: 0,
    ...overrides
  } as Repo
}

const DESKTOP = { kind: 'desktop' } as const
const RUNTIME = { kind: 'runtime', environmentId: 'env-1' } as const

describe('automationAuthorityPartitionContext', () => {
  it('answers for the desktop from desktop-owned repos only', () => {
    const tables = groupReposByAutomationAuthority([
      repo({ id: 'p1' }),
      repo({ id: 'p2', connectionId: 'devbox' }),
      repo({ id: 'p3', executionHostId: 'runtime:env-1' })
    ])
    const context = automationAuthorityPartitionContext(tables, DESKTOP)
    expect(context.repoConnectionId('p1')).toBeNull()
    expect(context.repoConnectionId('p2')).toBe('devbox')
    expect(context.repoConnectionId('p3')).toBeUndefined()
    expect(context.projectsAuthoritative).toBe(true)
  })

  it('answers for a runtime from that runtime’s repos only, and never authoritatively', () => {
    const tables = groupReposByAutomationAuthority([
      repo({ id: 'shared', executionHostId: 'runtime:env-1' }),
      repo({ id: 'other', executionHostId: 'runtime:env-2' }),
      // Same ID under the desktop, hosted over SSH: legal, and not this authority's answer.
      repo({ id: 'shared', connectionId: 'devbox' })
    ])
    const context = automationAuthorityPartitionContext(tables, RUNTIME)
    expect(context.repoConnectionId('shared')).toBeNull()
    expect(context.repoConnectionId('other')).toBeUndefined()
    expect(context.projectsAuthoritative).toBe(false)
  })

  it('reports an unmirrored authority as empty rather than borrowing another table', () => {
    const tables = groupReposByAutomationAuthority([repo({ id: 'p1' })])
    const context = automationAuthorityPartitionContext(tables, {
      kind: 'runtime',
      environmentId: 'never-connected'
    })
    expect(context.repoConnectionId('p1')).toBeUndefined()
    expect(context.projectsAuthoritative).toBe(false)
  })
})

describe('automationRuntimePairingRevision', () => {
  it('prefers the reported revision and rejects an unknown environment', () => {
    const environments = [
      { id: 'env-1', createdAt: 10, pairingRevision: 4 },
      { id: 'env-2', createdAt: 7 }
    ]
    expect(automationRuntimePairingRevision(environments, 'env-1')).toBe(4)
    expect(automationRuntimePairingRevision(environments, 'env-2')).toBe(7)
    expect(automationRuntimePairingRevision(environments, 'env-3')).toBe(-1)
  })
})

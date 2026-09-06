import { describe, expect, it } from 'vitest'
import {
  areTaskProviderIdentitiesEqual,
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart
} from './task-provider-identity'

const stored = {
  provider: 'plane',
  workspaceId: 'ws-1',
  workspaceSlug: '  acme  ',
  projectId: 'project-1',
  projectIdentifier: 'PROJ'
}

describe('plane task provider identity', () => {
  it('normalizes stored fields and trims blanks to null', () => {
    expect(normalizeTaskProviderIdentity('plane', stored)).toEqual({
      provider: 'plane',
      workspaceId: 'ws-1',
      workspaceSlug: 'acme',
      projectId: 'project-1',
      projectIdentifier: 'PROJ'
    })
    expect(
      normalizeTaskProviderIdentity('plane', { provider: 'plane', workspaceSlug: '   ' })
    ).toEqual({
      provider: 'plane',
      workspaceId: null,
      workspaceSlug: null,
      projectId: null,
      projectIdentifier: null
    })
  })

  it('rejects an identity belonging to another provider', () => {
    expect(normalizeTaskProviderIdentity('plane', { provider: 'jira', siteId: 'x' })).toBeNull()
    expect(isStoredTaskProviderIdentity('plane', { provider: 'jira' })).toBe(false)
  })

  it('accepts stored identities with absent or null fields', () => {
    expect(isStoredTaskProviderIdentity('plane', stored)).toBe(true)
    expect(isStoredTaskProviderIdentity('plane', { provider: 'plane' })).toBe(true)
    expect(isStoredTaskProviderIdentity('plane', { provider: 'plane', projectId: 7 })).toBe(false)
  })

  it('compares every plane field when deciding equality', () => {
    const identity = normalizeTaskProviderIdentity('plane', stored)
    expect(areTaskProviderIdentitiesEqual(identity, identity)).toBe(true)
    expect(
      areTaskProviderIdentitiesEqual(
        identity,
        normalizeTaskProviderIdentity('plane', { ...stored, projectIdentifier: 'OTHER' })
      )
    ).toBe(false)
  })

  it('keys the cache by workspace and project, preferring ids over slugs', () => {
    expect(taskProviderIdentityCachePart(normalizeTaskProviderIdentity('plane', stored))).toBe(
      'ws-1/project-1'
    )
    expect(
      taskProviderIdentityCachePart(
        normalizeTaskProviderIdentity('plane', {
          provider: 'plane',
          workspaceSlug: 'acme',
          projectIdentifier: 'PROJ'
        })
      )
    ).toBe('acme/PROJ')
  })
})

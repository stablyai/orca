import { describe, expect, it } from 'vitest'
import {
  areTaskProviderIdentitiesEqual,
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart
} from './task-provider-identity'

describe('azure-devops task provider identity', () => {
  const identity = {
    provider: 'azure-devops',
    organization: 'acme',
    project: 'Project',
    teamId: 'team-2',
    teamName: 'Mobile'
  }

  it('normalizes, validates and keys the identity', () => {
    expect(normalizeTaskProviderIdentity('azure-devops', identity)).toEqual(identity)
    expect(
      normalizeTaskProviderIdentity('azure-devops', { provider: 'azure-devops', teamId: ' ' })
    ).toEqual({
      provider: 'azure-devops',
      organization: null,
      project: null,
      teamId: null,
      teamName: null
    })
    expect(isStoredTaskProviderIdentity('azure-devops', identity)).toBe(true)
    expect(
      isStoredTaskProviderIdentity('azure-devops', { provider: 'azure-devops', teamId: 3 })
    ).toBe(false)
    expect(
      taskProviderIdentityCachePart(normalizeTaskProviderIdentity('azure-devops', identity))
    ).toBe('acme/Project/team-2')
    expect(
      areTaskProviderIdentitiesEqual(
        normalizeTaskProviderIdentity('azure-devops', identity),
        normalizeTaskProviderIdentity('azure-devops', { ...identity, teamName: 'Renamed' })
      )
    ).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  areTaskProviderIdentitiesEqual,
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart
} from './task-provider-identity'

describe('Paperclip task provider identity', () => {
  const identity = {
    provider: 'paperclip' as const,
    connectionId: 'connection-1',
    companyId: 'company-1',
    projectId: 'project-1'
  }

  it('normalizes bounded connection and provider scope without an origin', () => {
    expect(
      normalizeTaskProviderIdentity('paperclip', {
        ...identity,
        connectionId: ' connection-1 ',
        companyName: 'ignored display label'
      })
    ).toEqual(identity)
  })

  it('rejects malformed stored scope fields', () => {
    expect(isStoredTaskProviderIdentity('paperclip', identity)).toBe(true)
    expect(
      isStoredTaskProviderIdentity('paperclip', { ...identity, companyId: ['company-1'] })
    ).toBe(false)
  })

  it('separates connection, company, and project cache authorities', () => {
    expect(taskProviderIdentityCachePart(identity)).toBe('connection-1/company-1/project-1')
    expect(areTaskProviderIdentitiesEqual(identity, { ...identity, companyId: 'company-2' })).toBe(
      false
    )
    expect(areTaskProviderIdentitiesEqual(identity, { ...identity, projectId: 'project-2' })).toBe(
      false
    )
  })
})

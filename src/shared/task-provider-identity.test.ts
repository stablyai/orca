import { describe, expect, it } from 'vitest'
import {
  areTaskProviderIdentitiesEqual,
  isStoredTaskProviderIdentity,
  normalizeTaskProviderIdentity,
  taskProviderIdentityCachePart
} from './task-provider-identity'

describe('task-provider-identity Huly branch', () => {
  it('normalizes a Huly identity with connectionId and optional workspace/team fields', () => {
    const result = normalizeTaskProviderIdentity('huly', {
      provider: 'huly',
      connectionId: 'huly-abc',
      workspaceId: 'wsp-1',
      workspaceName: 'My Workspace',
      teamId: 'team-1',
      teamKey: 'CORE'
    })
    expect(result).toEqual({
      provider: 'huly',
      connectionId: 'huly-abc',
      workspaceId: 'wsp-1',
      workspaceName: 'My Workspace',
      teamId: 'team-1',
      teamKey: 'CORE'
    })
  })

  it('normalizes a minimal Huly identity (connectionId only) and drops empty strings', () => {
    const result = normalizeTaskProviderIdentity('huly', {
      provider: 'huly',
      connectionId: 'huly-min',
      workspaceId: '   ',
      teamKey: ''
    })
    expect(result).toEqual({
      provider: 'huly',
      connectionId: 'huly-min',
      workspaceId: null,
      workspaceName: null,
      teamId: null,
      teamKey: null
    })
  })

  it('rejects a Huly identity without a connectionId', () => {
    expect(
      normalizeTaskProviderIdentity('huly', { provider: 'huly', workspaceId: 'wsp' })
    ).toBeNull()
  })

  it('rejects mismatched provider fields', () => {
    expect(
      normalizeTaskProviderIdentity('huly', {
        provider: 'linear',
        connectionId: 'x'
      })
    ).toBeNull()
  })

  it('rejects non-object payloads', () => {
    expect(normalizeTaskProviderIdentity('huly', null)).toBeNull()
    expect(normalizeTaskProviderIdentity('huly', 'huly-abc')).toBeNull()
  })

  it('isStoredTaskProviderIdentity treats null/undefined as valid', () => {
    expect(isStoredTaskProviderIdentity('huly', undefined)).toBe(true)
    expect(isStoredTaskProviderIdentity('huly', null)).toBe(true)
  })

  it('isStoredTaskProviderIdentity rejects wrong provider or missing connectionId', () => {
    expect(isStoredTaskProviderIdentity('huly', { provider: 'huly' })).toBe(false)
    expect(isStoredTaskProviderIdentity('huly', { provider: 'linear', connectionId: 'x' })).toBe(
      false
    )
  })

  it('isStoredTaskProviderIdentity accepts a well-formed Huly identity', () => {
    expect(
      isStoredTaskProviderIdentity('huly', { provider: 'huly', connectionId: 'huly-abc' })
    ).toBe(true)
    expect(
      isStoredTaskProviderIdentity('huly', {
        provider: 'huly',
        connectionId: 'huly-abc',
        workspaceId: null,
        workspaceName: null,
        teamId: null,
        teamKey: null
      })
    ).toBe(true)
  })

  it('isStoredTaskProviderIdentity rejects a non-string optional field', () => {
    expect(
      isStoredTaskProviderIdentity('huly', {
        provider: 'huly',
        connectionId: 'huly-abc',
        workspaceId: 123
      })
    ).toBe(false)
  })

  it('taskProviderIdentityCachePart returns empty string for null identity', () => {
    expect(taskProviderIdentityCachePart(null)).toBe('')
  })

  it('taskProviderIdentityCachePart joins connectionId/workspace/team with /', () => {
    expect(
      taskProviderIdentityCachePart({
        provider: 'huly',
        connectionId: 'huly-abc',
        workspaceId: 'wsp-1',
        teamId: 'team-1'
      })
    ).toBe('huly-abc/wsp-1/team-1')
  })

  it('taskProviderIdentityCachePart falls back to teamKey when teamId is missing', () => {
    expect(
      taskProviderIdentityCachePart({
        provider: 'huly',
        connectionId: 'huly-abc',
        teamKey: 'CORE'
      })
    ).toBe('huly-abc/CORE')
  })

  it('taskProviderIdentityCachePart includes only connectionId when no team or workspace', () => {
    expect(taskProviderIdentityCachePart({ provider: 'huly', connectionId: 'huly-abc' })).toBe(
      'huly-abc'
    )
  })

  it('taskProviderIdentityCachePart isolates two connections with the same workspace', () => {
    const a = taskProviderIdentityCachePart({
      provider: 'huly',
      connectionId: 'huly-a',
      workspaceId: 'wsp'
    })
    const b = taskProviderIdentityCachePart({
      provider: 'huly',
      connectionId: 'huly-b',
      workspaceId: 'wsp'
    })
    expect(a).not.toBe(b)
  })

  it('areTaskProviderIdentitiesEqual compares connectionId and team fields', () => {
    const a = {
      provider: 'huly' as const,
      connectionId: 'huly-a',
      workspaceId: 'wsp-1',
      teamId: 'team-1'
    }
    const b = {
      provider: 'huly' as const,
      connectionId: 'huly-a',
      workspaceId: 'wsp-1',
      teamId: 'team-1'
    }
    const c = {
      provider: 'huly' as const,
      connectionId: 'huly-b',
      workspaceId: 'wsp-1',
      teamId: 'team-1'
    }
    expect(areTaskProviderIdentitiesEqual(a, b)).toBe(true)
    expect(areTaskProviderIdentitiesEqual(a, c)).toBe(false)
    expect(areTaskProviderIdentitiesEqual(a, null)).toBe(false)
    expect(areTaskProviderIdentitiesEqual(null, null)).toBe(true)
  })
})

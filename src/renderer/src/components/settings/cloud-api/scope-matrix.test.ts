import { describe, expect, it } from 'vitest'
import type { CloudApiScope } from '../../../../../shared/cloud-api/cloud-api-types'
import { SCOPE_RESOURCES, levelOf, withLevel } from './ScopeMatrix'

const byId = (id: string) => SCOPE_RESOURCES.find((resource) => resource.id === id)!

describe('scope matrix', () => {
  it('reads a level from scopes', () => {
    const scopes = new Set<CloudApiScope>(['workspaces:read', 'workspaces:write', 'routines:read'])
    expect(levelOf(byId('workspaces'), scopes)).toBe('write')
    expect(levelOf(byId('routines'), scopes)).toBe('read')
    expect(levelOf(byId('projects'), scopes)).toBe('none')
  })

  it('write includes read, and none clears both', () => {
    const write = withLevel(byId('projects'), new Set(), 'write')
    expect([...write].sort()).toEqual(['projects:read', 'projects:write'])
    expect([...withLevel(byId('projects'), write, 'none')]).toEqual([])
    expect([...withLevel(byId('projects'), write, 'read')]).toEqual(['projects:read'])
  })

  it('handles write-only and read-only resources', () => {
    expect([...withLevel(byId('messages'), new Set(), 'write')]).toEqual(['messages:write'])
    expect([...withLevel(byId('audit'), new Set(), 'read')]).toEqual(['audit:read'])
  })
})

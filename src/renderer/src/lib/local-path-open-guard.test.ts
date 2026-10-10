import { describe, expect, it } from 'vitest'
import { UNRESOLVED_OWNER_HOST_ID } from '../../../shared/execution-host'
import { getLocalPathOpenOwnerForRoute, isLocalPathOpenBlocked } from './local-path-open-guard'

describe('isLocalPathOpenBlocked', () => {
  it('allows only a path this computer owns', () => {
    expect(isLocalPathOpenBlocked('local')).toBe(false)
    expect(isLocalPathOpenBlocked({ kind: 'resolved', owner: 'local' })).toBe(false)
  })

  it.each([
    ['an SSH host', 'ssh:ssh-1'],
    ['a paired server', 'runtime:env-1'],
    ['the unresolved sentinel', UNRESOLVED_OWNER_HOST_ID],
    ['an unplaced owner', 'unresolved']
  ] as const)('refuses %s', (_label, owner) => {
    expect(isLocalPathOpenBlocked(owner)).toBe(true)
  })

  it('refuses a missing or ambiguous owner match', () => {
    expect(isLocalPathOpenBlocked({ kind: 'missing' })).toBe(true)
    expect(isLocalPathOpenBlocked({ kind: 'ambiguous' })).toBe(true)
    expect(isLocalPathOpenBlocked({ kind: 'resolved', owner: 'runtime:env-1' })).toBe(true)
  })
})

describe('getLocalPathOpenOwnerForRoute', () => {
  it('spells a route as its owning host', () => {
    expect(getLocalPathOpenOwnerForRoute({})).toBe('local')
    expect(getLocalPathOpenOwnerForRoute({ runtimeEnvironmentId: ' env-2 ' })).toBe('runtime:env-2')
    expect(getLocalPathOpenOwnerForRoute({ connectionId: 'ssh-1' })).toBe('ssh:ssh-1')
    expect(
      getLocalPathOpenOwnerForRoute({ runtimeEnvironmentId: null, ownerUnresolved: true })
    ).toBe('unresolved')
  })
})

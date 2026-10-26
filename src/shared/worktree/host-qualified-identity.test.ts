import { describe, expect, expectTypeOf, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../execution-host'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity,
  hostWorktreeTarget,
  type HostScopedWorktreeKey,
  type HostWorktreeTarget
} from './host-qualified-identity'

const WORKTREE_ID = 'repo-1::/work/orca'

describe('worktree host identity', () => {
  it('separates two hosts that publish the same id', () => {
    expect(getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: 'local' })).not.toBe(
      getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: 'ssh:build-box' })
    )
  })

  it('gives an unqualified row its own bucket', () => {
    expect(getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: undefined })).not.toBe(
      getWorktreeHostIdentity({ id: WORKTREE_ID, hostId: 'local' })
    )
  })

  // Indexes recover IDs from composite keys; a separator in the host would truncate workspace IDs.
  it('round-trips the id back out for every host shape', () => {
    const hostIds = [
      undefined,
      'local',
      toSshExecutionHostId('build-box'),
      toSshExecutionHostId('deploy@10.0.0.4:2222'),
      toRuntimeExecutionHostId('03ef704c-b180-4b10-998d-e28fbd5de9a3')
    ] as const

    for (const hostId of hostIds) {
      expect(getWorktreeIdFromHostIdentity(composeWorktreeHostIdentity(hostId, WORKTREE_ID))).toBe(
        WORKTREE_ID
      )
    }
  })

  it('round-trips a workspace id that itself contains the separator', () => {
    // Only the host is separator-free; workspace paths can contain the delimiter.
    const awkwardId = 'repo-1::/work/a|b/orca'

    expect(
      getWorktreeIdFromHostIdentity(
        composeWorktreeHostIdentity(toSshExecutionHostId('build-box'), awkwardId)
      )
    ).toBe(awkwardId)
  })

  it('keeps a host id free of the separator by construction', () => {
    expect(toSshExecutionHostId('we|rd')).not.toContain('|')
    expect(toRuntimeExecutionHostId('we|rd')).not.toContain('|')
  })

  it('rejects identities without a host separator', () => {
    expect(getExecutionHostIdFromWorktreeHostIdentity('ssh:build-box')).toBeUndefined()
  })

  // Unknown ownership cannot authorize a destructive action on local.
  it('leaves an unqualified identity without a host', () => {
    expect(
      getExecutionHostIdFromWorktreeHostIdentity(
        composeWorktreeHostIdentity(undefined, WORKTREE_ID)
      )
    ).toBeUndefined()
  })

  it('recovers the host from a qualified identity', () => {
    expect(
      getExecutionHostIdFromWorktreeHostIdentity(composeWorktreeHostIdentity('local', WORKTREE_ID))
    ).toBe('local')
    expect(
      getExecutionHostIdFromWorktreeHostIdentity(
        composeWorktreeHostIdentity(toSshExecutionHostId('build-box'), WORKTREE_ID)
      )
    ).toBe(toSshExecutionHostId('build-box'))
  })
})

// Persisted identity aliases and recency keys freeze these bytes (D25).
describe('worktree host identity golden bytes', () => {
  it.each([
    ['local', 'repo::/p', 'local|repo::/p'],
    [undefined, 'repo::/p', '|repo::/p'],
    [
      toSshExecutionHostId('deploy@10.0.0.4:2222'),
      'repo::/p',
      'ssh:deploy%4010.0.0.4%3A2222|repo::/p'
    ],
    [toSshExecutionHostId('we|rd'), 'repo::/p', 'ssh:we%7Crd|repo::/p'],
    [toRuntimeExecutionHostId('env 1/a'), 'repo::/p', 'runtime:env%201%2Fa|repo::/p'],
    ['local', 'repo::/work/a|b', 'local|repo::/work/a|b']
  ] as const)('composes %s + %s as %s', (hostId, worktreeId, expected) => {
    const key = composeWorktreeHostIdentity(hostId, worktreeId)
    expect(key).toBe(expected)
    expect(getWorktreeHostIdentity({ id: worktreeId, hostId })).toBe(expected)
    expect(getWorktreeIdFromHostIdentity(key)).toBe(worktreeId)
    expect(getExecutionHostIdFromWorktreeHostIdentity(key)).toBe(hostId)
  })

  it('brands the key so a plain string cannot pose as one', () => {
    const key = composeWorktreeHostIdentity('local', WORKTREE_ID)
    expectTypeOf(key).toEqualTypeOf<HostScopedWorktreeKey>()
    expectTypeOf<HostScopedWorktreeKey>().toExtend<string>()
    expectTypeOf<string>().not.toExtend<HostScopedWorktreeKey>()
    const raw: string = key
    // @ts-expect-error a raw string is not a host-scoped key
    const forged: HostScopedWorktreeKey = WORKTREE_ID
    expect([raw, forged]).toEqual([key, WORKTREE_ID])
  })
})

describe('host worktree target', () => {
  it('carries the row id and its concrete host', () => {
    const target = hostWorktreeTarget({ id: WORKTREE_ID, hostId: toSshExecutionHostId('box') })
    expect(target).toEqual({ id: WORKTREE_ID, hostId: 'ssh:box' })
  })

  it('cannot be forged from a plain object or built without a host', () => {
    // @ts-expect-error only hostWorktreeTarget mints the brand
    const forged: HostWorktreeTarget = { id: WORKTREE_ID, hostId: 'local' }
    // @ts-expect-error an unqualified row has no host to scope to
    hostWorktreeTarget({ id: WORKTREE_ID, hostId: undefined })
    expect(forged.id).toBe(WORKTREE_ID)
  })
})

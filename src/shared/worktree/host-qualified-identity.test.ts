import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from '../execution-host'
import {
  composeWorktreeHostIdentity,
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeHostIdentity,
  getWorktreeIdFromHostIdentity
} from './host-qualified-identity'

describe('worktree host identity', () => {
  it('rejects identities without a host separator', () => {
    expect(getExecutionHostIdFromWorktreeHostIdentity('ssh:build-box')).toBeUndefined()
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
})

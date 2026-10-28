import { describe, expect, it } from 'vitest'
import { toRuntimeExecutionHostId, toSshExecutionHostId } from './execution-host'
import { getRepoHostIdentityForParts, getRepoRegistrationHostIds } from './repo-host-identity'

// Why: these keys index persisted and cross-module repo state, so the bytes are frozen (D25).
describe('repo host identity golden bytes', () => {
  it.each([
    ['repo-1', 'local', 'local\0repo-1'],
    [
      'repo-1',
      toSshExecutionHostId('deploy@10.0.0.4:2222'),
      'ssh:deploy%4010.0.0.4%3A2222\0repo-1'
    ],
    ['repo-1', toRuntimeExecutionHostId('env 1/a'), 'runtime:env%201%2Fa\0repo-1'],
    ['repo|1::x', 'local', 'local\0repo|1::x'],
    ['repo-1', '', '\0repo-1']
  ] as const)('composes %s on %s', (repoId, hostId, expected) => {
    expect(getRepoHostIdentityForParts(repoId, hostId)).toBe(expected)
  })
})

describe('getRepoRegistrationHostIds', () => {
  it('collects each host registering the id once, across both SSH spellings', () => {
    const repos = [
      { id: 'repo-1' },
      { id: 'repo-1', connectionId: 'box' },
      { id: 'repo-1', executionHostId: 'ssh:box' as const },
      { id: 'repo-2', executionHostId: 'runtime:env' as const }
    ]
    expect(getRepoRegistrationHostIds(repos, 'repo-1')).toEqual(new Set(['local', 'ssh:box']))
    expect(getRepoRegistrationHostIds(repos, 'missing').size).toBe(0)
  })
})

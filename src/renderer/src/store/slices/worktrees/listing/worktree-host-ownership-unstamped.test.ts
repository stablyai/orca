import { describe, expect, it } from 'vitest'
import { worktreeMatchesHost } from './worktree-host-ownership'

describe('worktreeMatchesHost unstamped non-local rows', () => {
  it.each([
    ['stamped SSH row', { hostId: 'ssh:t' as const }, 'ssh:t' as const, true, true],
    ['stamped server row', { runtimeOwnerEnvironmentId: 'e' }, 'runtime:e' as const, true, true],
    ['unstamped row claimed by local', {}, 'local' as const, true, true],
    ['unstamped row claimed by SSH', {}, 'ssh:t' as const, true, true],
    ['unstamped row claimed by a server', {}, 'runtime:e' as const, true, true],
    ['unstamped row refused by SSH', {}, 'ssh:t' as const, false, false],
    ['unstamped row, no hint, SSH', {}, 'ssh:t' as const, undefined, false],
    ['unstamped row, no hint, local', {}, 'local' as const, undefined, true]
  ])('%s', (_name, row, hostId, unhostedWorktreesMatchHost, matches) => {
    expect(worktreeMatchesHost(row, hostId, { unhostedWorktreesMatchHost })).toBe(matches)
  })
})

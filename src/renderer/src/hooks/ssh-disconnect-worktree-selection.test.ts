import { describe, expect, it } from 'vitest'
import { getSshDisconnectWorktreeIds } from './ssh-disconnect-worktree-selection'

describe('getSshDisconnectWorktreeIds', () => {
  it('keeps same-repository worktrees owned by local and sibling SSH hosts', () => {
    expect(
      getSshDisconnectWorktreeIds(
        {
          repos: [
            { id: 'same-repo', connectionId: 'ssh-a', executionHostId: 'ssh:ssh-a' },
            { id: 'same-repo', connectionId: 'ssh-b', executionHostId: 'ssh:ssh-b' },
            { id: 'same-repo', connectionId: 'ssh-a', executionHostId: 'local' }
          ],
          worktreesByRepo: {
            'same-repo': [
              { id: 'ssh-a-worktree', hostId: 'ssh:ssh-a' },
              { id: 'ssh-b-worktree', hostId: 'ssh:ssh-b' },
              { id: 'local-worktree', hostId: 'local' },
              { id: 'ambiguous-legacy-worktree' }
            ]
          }
        },
        'ssh-a'
      )
    ).toEqual(new Set(['ssh-a-worktree']))
  })

  it('matches an SSH execution host even when connectionId is absent', () => {
    expect(
      getSshDisconnectWorktreeIds(
        {
          repos: [{ id: 'remote-repo', connectionId: null, executionHostId: 'ssh:ssh-a' }],
          worktreesByRepo: {
            'remote-repo': [{ id: 'remote-worktree', hostId: 'ssh:ssh-a' }]
          }
        },
        'ssh-a'
      )
    ).toEqual(new Set(['remote-worktree']))
  })

  it('attributes a legacy unhosted worktree to an unambiguous SSH repo owner', () => {
    expect(
      getSshDisconnectWorktreeIds(
        {
          repos: [{ id: 'remote-repo', connectionId: 'ssh-a' }],
          worktreesByRepo: {
            'remote-repo': [{ id: 'legacy-worktree' }]
          }
        },
        'ssh-a'
      )
    ).toEqual(new Set(['legacy-worktree']))
  })

  it('uses the canonical encoded execution host id for matching', () => {
    expect(
      getSshDisconnectWorktreeIds(
        {
          repos: [
            {
              id: 'encoded-repo',
              connectionId: null,
              executionHostId: 'ssh:target%20one%2Fprimary'
            }
          ],
          worktreesByRepo: {
            'encoded-repo': [{ id: 'encoded-worktree', hostId: 'ssh:target%20one%2Fprimary' }]
          }
        },
        'target one/primary'
      )
    ).toEqual(new Set(['encoded-worktree']))
  })
})

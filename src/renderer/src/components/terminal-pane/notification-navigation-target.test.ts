import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { getNotificationNavigationTarget } from './notification-navigation-target'

const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

function targetFor(
  ptyId: string,
  worktrees: { id: string; repoId: string; hostId?: string }[]
): ReturnType<typeof getNotificationNavigationTarget> {
  return getNotificationNavigationTarget(
    {
      activeWorktreeId: null,
      tabsByWorktree: { 'wt-primary': [{ id: 'tab-1', ptyId }] },
      terminalLayoutsByTabId: {},
      worktreesByRepo: { repo1: worktrees },
      repos: [{ id: 'repo1', connectionId: null }]
    } as never,
    'wt-primary',
    paneKey
  )
}

describe('getNotificationNavigationTarget', () => {
  it.each([
    [
      'runtime pane',
      toRemoteRuntimePtyId('pty-1', 'runtime-a'),
      [{ id: 'wt-primary', repoId: 'repo1' }],
      { executionHostId: 'runtime:runtime-a', paneKey }
    ],
    [
      'local pane with duplicate owners',
      'pty-1',
      [
        { id: 'wt-primary', repoId: 'repo1' },
        { id: 'wt-primary', repoId: 'repo1', hostId: 'ssh:other' }
      ],
      { executionHostId: 'local', paneKey }
    ],
    [
      'foreign PTY with known owner',
      'remote:unscoped',
      [{ id: 'wt-primary', repoId: 'repo1', hostId: 'ssh:known' }],
      { executionHostId: 'ssh:known' }
    ],
    [
      'foreign PTY without remote owner',
      'remote:unscoped',
      [{ id: 'wt-primary', repoId: 'repo1' }],
      {}
    ]
  ] as const)('builds a safe %s target', (_, ptyId, worktrees, expected) => {
    expect(targetFor(ptyId, [...worktrees])).toEqual(expected)
  })
})

import {
  createTestStore,
  makeTab,
  makeWorktree,
  TEST_REPO
} from '@/store/slices/store-test-helpers'
import { parseExecutionHostId } from '../../../../shared/execution-host'
import { describe, expect, it } from 'vitest'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { getNotificationNavigationTarget } from './notification-navigation-target'

const paneKey = 'tab-1:11111111-1111-4111-8111-111111111111'

function targetFor(
  ptyId: string,
  worktrees: { id: string; repoId: string; hostId?: string }[]
): ReturnType<typeof getNotificationNavigationTarget> {
  const store = createTestStore()
  store.setState({
    activeWorktreeId: null,
    tabsByWorktree: { 'wt-primary': [makeTab({ id: 'tab-1', worktreeId: 'wt-primary', ptyId })] },
    terminalLayoutsByTabId: {},
    worktreesByRepo: {
      repo1: worktrees.map((worktree) =>
        makeWorktree({ ...worktree, hostId: parseExecutionHostId(worktree.hostId)?.id })
      )
    },
    repos: [TEST_REPO]
  })
  return getNotificationNavigationTarget(store.getState(), 'wt-primary', paneKey)
}

describe('getNotificationNavigationTarget', () => {
  it('keeps the captured transport owner when catalog hydration has no owner yet', () => {
    const store = createTestStore()
    expect(
      getNotificationNavigationTarget(store.getState(), 'wt-primary', paneKey, {
        executionHostId: null,
        runtimeEnvironmentId: 'captured-host'
      })
    ).toEqual({ executionHostId: 'runtime:captured-host', paneKey })
  })

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

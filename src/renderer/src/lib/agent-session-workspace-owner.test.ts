import { describe, expect, it } from 'vitest'
import { resolveAgentSessionWorkspaceOwner } from './agent-session-workspace-owner'

function createStore() {
  const local = {
    id: 'repo-1::feature',
    repoId: 'repo-1',
    path: '/local/feature'
  }
  const remote = {
    ...local,
    hostId: 'runtime:remote-1',
    path: '/remote/feature'
  }
  return {
    local,
    remote,
    store: {
      allWorktrees: () => [local],
      detectedWorktreesByRepo: {
        'repo-1': { worktrees: [remote] }
      },
      repos: [
        { id: 'repo-1', path: '/local/repo' },
        { id: 'repo-1', path: '/remote/repo', executionHostId: 'runtime:remote-1' }
      ],
      getKnownWorktreeById: () => null
    }
  }
}

describe('resolveAgentSessionWorkspaceOwner', () => {
  it('selects the worktree and repository on the declared execution host', () => {
    const { remote, store } = createStore()

    expect(
      resolveAgentSessionWorkspaceOwner(store as never, remote.id, 'runtime:remote-1')
    ).toMatchObject({
      executionHostId: 'runtime:remote-1',
      worktree: remote,
      repo: { id: 'repo-1', executionHostId: 'runtime:remote-1' }
    })
  })

  it('fails closed when the worktree id has owners on multiple hosts', () => {
    const { local, store } = createStore()

    expect(() => resolveAgentSessionWorkspaceOwner(store as never, local.id)).toThrowError(
      'The target workspace host is unavailable or ambiguous.'
    )
  })

  it('fails closed when the declared execution host has no owner', () => {
    const { local, store } = createStore()
    const strictStore = {
      ...store,
      allWorktrees: () => [local],
      worktreesByRepo: { 'repo-1': [local] },
      detectedWorktreesByRepo: {}
    }

    expect(() =>
      resolveAgentSessionWorkspaceOwner(strictStore as never, local.id, 'runtime:missing')
    ).toThrowError('The target workspace host is unavailable or ambiguous.')
  })

  it('uses an explicit SSH route for legacy ownerless workspace metadata', () => {
    const { local, store } = createStore()
    const legacyStore = {
      ...store,
      allWorktrees: () => [local],
      worktreesByRepo: { 'repo-1': [local] },
      detectedWorktreesByRepo: {},
      repos: [{ id: 'repo-1', path: '/legacy/repo' }]
    }

    expect(
      resolveAgentSessionWorkspaceOwner(legacyStore as never, local.id, 'ssh:legacy-target', {
        allowLegacyExpectedOwner: true
      })
    ).toMatchObject({
      executionHostId: 'ssh:legacy-target',
      worktree: local,
      repo: { id: 'repo-1' }
    })
  })
})

import { describe, expect, it } from 'vitest'
import { resolveAgentBackgroundWorkspaceOwner } from './agent-background-workspace-owner'

describe('resolveAgentBackgroundWorkspaceOwner', () => {
  it('fails closed when indexed and detected worktrees claim different hosts', () => {
    const indexed = {
      id: 'repo-1::feature',
      repoId: 'repo-1',
      path: '/local/feature'
    }
    const detected = {
      ...indexed,
      hostId: 'runtime:remote-1',
      path: '/remote/feature'
    }
    const store = {
      allWorktrees: () => [indexed],
      detectedWorktreesByRepo: {
        'repo-1': { worktrees: [detected] }
      },
      repos: [
        { id: 'repo-1', path: '/local/repo' },
        { id: 'repo-1', path: '/remote/repo', executionHostId: 'runtime:remote-1' }
      ],
      getKnownWorktreeById: () => null
    }

    expect(() => resolveAgentBackgroundWorkspaceOwner(store as never, indexed.id)).toThrowError(
      'The target workspace host is unavailable or ambiguous.'
    )
  })
})

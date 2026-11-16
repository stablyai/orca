import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getConnectionIdFromState } from '@/lib/workspace/ownership/connection-owner-resolution'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import { resolveKnownWorktreeRootPathLink } from './terminal-worktree-path-link'

type WorktreeRootPathState = NonNullable<Parameters<typeof resolveKnownWorktreeRootPathLink>[1]>

function createState(
  worktreesByRepo: Record<
    string,
    { id: string; path: string; hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }[]
  >
): WorktreeRootPathState {
  return {
    worktreesByRepo: Object.fromEntries(
      Object.entries(worktreesByRepo).map(([repoId, rows]) => [
        repoId,
        rows.map((row) => ({ ...row, repoId, hostId: row.hostId ?? 'local' }))
      ])
    )
  }
}

const remoteContext = (environmentId: string, worktreeId = 'source') => ({
  target: { kind: 'environment' as const, environmentId: environmentId },
  worktreeId,
  worktreePath: '/source'
})

describe('terminal root link ownership', () => {
  it('selects the matching host when three hosts publish the same root', () => {
    const state = createState({
      repo: [
        { id: 'same-id', path: '/collision', hostId: 'local' },
        { id: 'same-id', path: '/collision', hostId: 'runtime:alpha' },
        { id: 'same-id', path: '/collision', hostId: 'runtime:beta' }
      ]
    })
    for (const host of ['alpha', 'beta']) {
      expect(resolveKnownWorktreeRootPathLink('/collision', state, remoteContext(host))).toEqual({
        id: 'same-id',
        path: '/collision',
        executionHostId: `runtime:${host}`
      })
    }
    expect(resolveKnownWorktreeRootPathLink('/collision', state)?.executionHostId).toBe('local')
  })

  it('keeps same-host duplicate roots ambiguous', () => {
    const state = createState({
      repo: [
        { id: 'one', path: '/collision', hostId: 'runtime:alpha' },
        { id: 'two', path: '/collision/', hostId: 'runtime:alpha' }
      ]
    })
    expect(resolveKnownWorktreeRootPathLink('/collision', state, remoteContext('alpha'))).toBeNull()
  })

  it('keeps a nested SSH target distinct from the paired host serving it', () => {
    const state = createState({
      repo: [
        { id: 'source', path: '/source', hostId: 'ssh:nested', runtimeOwnerEnvironmentId: 'hub' },
        {
          id: 'nested',
          path: '/collision',
          hostId: 'ssh:nested',
          runtimeOwnerEnvironmentId: 'hub'
        },
        { id: 'hub-root', path: '/collision', hostId: 'runtime:hub' }
      ]
    })
    expect(resolveKnownWorktreeRootPathLink('/collision', state, remoteContext('hub'))).toEqual({
      id: 'nested',
      path: '/collision',
      executionHostId: 'ssh:nested'
    })
  })

  it('does not cache a repo owner after that owner changes', () => {
    const worktreesByRepo = { repo: [{ id: 'target', repoId: 'repo', path: '/target' }] }
    const first = {
      worktreesByRepo,
      repos: [{ id: 'repo', executionHostId: 'runtime:alpha' as const }]
    }
    const second = {
      worktreesByRepo,
      repos: [{ id: 'repo', executionHostId: 'runtime:beta' as const }]
    }
    expect(resolveKnownWorktreeRootPathLink('/target', first, remoteContext('alpha'))?.id).toBe(
      'target'
    )
    expect(resolveKnownWorktreeRootPathLink('/target', second, remoteContext('alpha'))).toBeNull()
    expect(resolveKnownWorktreeRootPathLink('/target', second, remoteContext('beta'))?.id).toBe(
      'target'
    )
  })

  describe('direct SSH source with a same-id desktop twin', () => {
    const twin = (hostId: ExecutionHostId) =>
      makeWorktree('repo::/home/u/proj', 'proj', { repoId: 'repo', path: '/home/u/proj', hostId })
    const sameIdState = (activeHost: ExecutionHostId | null) => ({
      repos: [
        { ...makeRepo(), id: 'repo', executionHostId: 'local' as const },
        { ...makeRepo(), id: 'repo', connectionId: 'box', executionHostId: 'ssh:box' as const }
      ],
      worktreesByRepo: { repo: [twin('local'), twin('ssh:box')] },
      folderWorkspaces: [],
      projectGroups: [],
      activeWorktreeId: activeHost ? 'repo::/home/u/proj' : null,
      activeWorkspaceExecutionHostId: activeHost
    })
    const sshContext = (state: Parameters<typeof getConnectionIdFromState>[0]) => ({
      target: { kind: 'local' as const },
      worktreeId: 'repo::/home/u/proj',
      worktreePath: '/home/u/proj',
      connectionId: getConnectionIdFromState(state, 'repo::/home/u/proj') ?? undefined
    })

    it('resolves the root on the active SSH host, not the desktop', () => {
      const state = sameIdState('ssh:box')
      const context = sshContext(state)
      expect(context.connectionId).toBeUndefined()
      expect(resolveKnownWorktreeRootPathLink('/home/u/proj', state, context)).toEqual({
        id: 'repo::/home/u/proj',
        path: '/home/u/proj',
        executionHostId: 'ssh:box'
      })
    })
  })
})

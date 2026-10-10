import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getConnectionIdFromState } from '@/lib/connection-owner-resolution'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import {
  normalizeWorktreeRootPathForTerminalLink,
  resolveKnownWorktreeRootPathLink
} from './terminal-worktree-path-link'

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

describe('resolveKnownWorktreeRootPathLink', () => {
  it('resolves an exact known worktree root path', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature', state)).toEqual({
      id: 'wt-1',
      path: '/repo/feature',
      executionHostId: 'local'
    })
  })

  it('does not resolve an unknown directory path', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/other', state)).toBeNull()
  })

  it('does not resolve a path inside a known worktree', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature/src/main.ts', state)).toBeNull()
  })

  it('matches trailing separators without trimming filesystem roots', () => {
    const state = createState({
      repo: [
        { id: 'posix-root', path: '/' },
        { id: 'posix-wt', path: '/repo/feature' },
        { id: 'windows-root', path: 'C:\\' },
        { id: 'windows-wt', path: 'C:\\repo\\feature' }
      ]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature/', state)?.id).toBe('posix-wt')
    expect(resolveKnownWorktreeRootPathLink('C:\\repo\\feature\\', state)?.id).toBe('windows-wt')
    expect(normalizeWorktreeRootPathForTerminalLink('/')).toBe('/')
    expect(normalizeWorktreeRootPathForTerminalLink('C:\\')).toBe('C:/')
  })

  it('returns no match for duplicate root paths', () => {
    const state = createState({
      repo: [
        { id: 'wt-1', path: '/repo/feature' },
        { id: 'wt-2', path: '/repo/feature/' }
      ]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature', state)).toBeNull()
  })

  it('rebuilds the cached root index when worktreesByRepo is replaced', () => {
    const firstState = createState({
      repo: [{ id: 'wt-1', path: '/repo/feature' }]
    })
    const nextState = createState({
      repo: [{ id: 'wt-2', path: '/repo/feature' }]
    })

    expect(resolveKnownWorktreeRootPathLink('/repo/feature', firstState)?.id).toBe('wt-1')
    expect(resolveKnownWorktreeRootPathLink('/repo/feature', nextState)?.id).toBe('wt-2')
  })

  it('matches Windows paths across native and resolved separator styles', () => {
    const state = createState({
      repo: [{ id: 'wt-1', path: 'C:\\Users\\Alice\\Repo' }]
    })

    expect(resolveKnownWorktreeRootPathLink('C:\\Users\\Alice\\Repo\\', state)?.id).toBe('wt-1')
    expect(resolveKnownWorktreeRootPathLink('C:/Users/Alice/Repo', state)?.id).toBe('wt-1')
    expect(resolveKnownWorktreeRootPathLink('C:\\Users\\Alice\\Repo\\src', state)).toBeNull()
    expect(resolveKnownWorktreeRootPathLink('C:/Users/Alice/Repo/src', state)).toBeNull()
  })

  it('matches Windows and UNC roots case-insensitively without changing POSIX matching', () => {
    const state = createState({
      repo: [
        { id: 'wt-win', path: 'C:\\Users\\Alice\\Repo' },
        { id: 'wt-unc', path: '\\\\Server\\Share\\Repo' },
        { id: 'wt-posix', path: '/Users/Alice/Repo' }
      ]
    })

    expect(resolveKnownWorktreeRootPathLink('c:\\users\\alice\\repo', state)?.id).toBe('wt-win')
    expect(resolveKnownWorktreeRootPathLink('//server/share/repo', state)?.id).toBe('wt-unc')
    expect(resolveKnownWorktreeRootPathLink('/users/alice/repo', state)).toBeNull()
  })
})

const remoteContext = (environmentId: string, worktreeId = 'source') => ({
  settings: { activeRuntimeEnvironmentId: environmentId },
  worktreeId,
  worktreePath: '/source'
})

describe('terminal root link ownership', () => {
  it('does not select a desktop root from a managed terminal', () => {
    const state = createState({ desktop: [{ id: 'desktop', path: '/collision' }] })
    expect(
      resolveKnownWorktreeRootPathLink('/collision', state, remoteContext('remote'))
    ).toBeNull()
  })

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

  it('does not select another managed host even when its path is unique', () => {
    const state = createState({
      repo: [{ id: 'other', path: '/collision', hostId: 'runtime:beta' }]
    })
    expect(resolveKnownWorktreeRootPathLink('/collision', state, remoteContext('alpha'))).toBeNull()
  })

  it('keeps direct SSH roots scoped to their own connection', () => {
    const state = createState({
      repo: [
        { id: 'ssh-a', path: '/collision', hostId: 'ssh:alpha' },
        { id: 'ssh-b', path: '/collision', hostId: 'ssh:beta' }
      ]
    })
    const context = {
      settings: null,
      worktreeId: 'source',
      worktreePath: '/source',
      connectionId: 'alpha'
    }
    expect(resolveKnownWorktreeRootPathLink('/collision', state, context)?.id).toBe('ssh-a')
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

  it('uses the explicit pane owner for a non-git folder source', () => {
    const state = createState({
      repo: [{ id: 'target', path: '/target', hostId: 'runtime:alpha' }]
    })
    expect(
      resolveKnownWorktreeRootPathLink('/target', state, remoteContext('alpha', 'folder:source'))
        ?.id
    ).toBe('target')
  })

  it('does not use an active host that differs from the retained pane owner', () => {
    const state = {
      ...createState({ repo: [{ id: 'target', path: '/target', hostId: 'runtime:beta' }] }),
      activeWorktreeId: 'source',
      activeWorkspaceExecutionHostId: 'runtime:alpha' as const
    }
    expect(resolveKnownWorktreeRootPathLink('/target', state, remoteContext('beta'))?.id).toBe(
      'target'
    )
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
      settings: null,
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

    it('offers no root shortcut when the source host cannot be resolved', () => {
      const state = sameIdState(null)
      expect(resolveKnownWorktreeRootPathLink('/home/u/proj', state, sshContext(state))).toBeNull()
    })
  })

  it('does not treat a source whose owner rows have not loaded as local', () => {
    const state = {
      ...createState({ desktop: [{ id: 'desktop', path: '/target' }] }),
      runtimeEnvironments: [],
      runtimeEnvironmentCatalogHydrated: false
    }
    const context = { settings: null, worktreeId: 'restoring::/x', worktreePath: '/x' }
    expect(resolveKnownWorktreeRootPathLink('/target', state, context)).toBeNull()
  })
})

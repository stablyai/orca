/**
 * The pin cases are the ones that used to diverge: main resolved the repo and
 * said local while the renderer resolved the workspace and said SSH.
 */

import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import {
  findFolderWorkspaceCandidateRepos,
  resolveFolderWorkspaceHost,
  type FolderWorkspaceHostState
} from './folder-workspace-execution-host'

function workspace(overrides: Partial<FolderWorkspace> = {}): FolderWorkspace {
  return {
    id: 'fw-1',
    projectGroupId: 'group-1',
    name: 'App',
    folderPath: '/work/app',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function repo(overrides: Partial<Repo> & Pick<Repo, 'id' | 'path'>): Repo {
  return {
    displayName: overrides.id,
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  } as Repo
}

function state(overrides: Partial<FolderWorkspaceHostState> = {}): FolderWorkspaceHostState {
  return {
    folderWorkspaces: [workspace()],
    projectGroups: [
      {
        id: 'group-1',
        name: 'Work',
        parentPath: '/work',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      } satisfies ProjectGroup
    ],
    repos: [repo({ id: 'repo-1', path: '/work/app/repo', projectGroupId: 'group-1' })],
    ...overrides
  }
}

describe('folder workspace execution host', () => {
  it('answers with the workspace pin even when every repo under it is local', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        folderWorkspaces: [workspace({ executionHostId: 'ssh:box' })]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ssh', targetId: 'box' })
  })

  it('honours a local pin over an SSH repo', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        folderWorkspaces: [workspace({ executionHostId: 'local' })],
        repos: [
          repo({
            id: 'repo-1',
            path: '/work/app/repo',
            projectGroupId: 'group-1',
            connectionId: 'box'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'local' })
  })

  it('reports a scope that mixes local and SSH repos as ambiguous', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({ id: 'repo-1', path: '/work/app/a', projectGroupId: 'group-1' }),
          repo({
            id: 'repo-2',
            path: '/work/app/b',
            projectGroupId: 'group-1',
            connectionId: 'box'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ambiguous' })
  })

  it('reports two SSH connections as ambiguous', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({
            id: 'repo-1',
            path: '/work/app/a',
            projectGroupId: 'group-1',
            connectionId: 'box'
          }),
          repo({
            id: 'repo-2',
            path: '/work/app/b',
            projectGroupId: 'group-1',
            connectionId: 'other'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ambiguous' })
  })

  it('resolves a single SSH connection', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({
            id: 'repo-1',
            path: '/work/app/a',
            projectGroupId: 'group-1',
            connectionId: 'box'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ssh', targetId: 'box' })
  })

  // Nothing normalizes connection ids on write, so a blank one is local on both sides.
  it('treats a blank connection id as local rather than as a host named "  "', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({ id: 'repo-1', path: '/work/app/a', projectGroupId: 'group-1', connectionId: '  ' })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'local' })
  })

  it('separates a workspace that is gone from one that resolves to local', () => {
    expect(resolveFolderWorkspaceHost(state(), 'fw-missing')).toEqual({ kind: 'missing' })
    expect(resolveFolderWorkspaceHost(state({ repos: [] }), 'fw-1')).toEqual({ kind: 'local' })
  })

  // SSH ownership has two spellings on a repo row. A row carrying only `executionHostId: 'ssh:*'`
  // has no `connectionId`, and reading the raw field counted it as a local repo — so a workspace
  // whose files live on an SSH host resolved `local`, which is an execute-here answer for a remote
  // path. These fire on well-formed rows; nothing malformed is involved.
  it('resolves a repo that names its SSH host only through executionHostId', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({
            id: 'repo-1',
            path: '/work/app/a',
            projectGroupId: 'group-1',
            executionHostId: 'ssh:box'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ssh', targetId: 'box' })
  })

  it('mixes such a repo with a local one as ambiguous rather than local', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({ id: 'repo-1', path: '/work/app/a', projectGroupId: 'group-1' }),
          repo({
            id: 'repo-2',
            path: '/work/app/b',
            projectGroupId: 'group-1',
            executionHostId: 'ssh:box'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ambiguous' })
  })

  it('matches a scope connection against such a repo instead of calling it ambiguous', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        folderWorkspaces: [workspace({ connectionId: 'box' })],
        repos: [
          repo({
            id: 'repo-1',
            path: '/work/app/a',
            projectGroupId: 'group-1',
            executionHostId: 'ssh:box'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ssh', targetId: 'box' })
  })

  it('reads the target off the host, so a percent-encoded id decodes', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({
            id: 'repo-1',
            path: '/work/app/a',
            projectGroupId: 'group-1',
            executionHostId: `ssh:${encodeURIComponent('box 1')}`
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ssh', targetId: 'box 1' })
  })

  // Deliberately unchanged: a `runtime:` row's nested SSH target is not this client's to dial, but
  // narrowing that here would be a second behaviour change riding on the SSH fix.
  it('leaves a runtime row contributing its nested connection exactly as before', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        repos: [
          repo({
            id: 'repo-1',
            path: '/work/app/a',
            projectGroupId: 'group-1',
            executionHostId: 'runtime:env-1',
            connectionId: 'nested-box'
          })
        ]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'ssh', targetId: 'nested-box' })
  })

  it('still answers local for a runtime pin, which the type cannot express otherwise', () => {
    const resolved = resolveFolderWorkspaceHost(
      state({
        folderWorkspaces: [workspace({ executionHostId: 'runtime:env-1' })]
      }),
      'fw-1'
    )

    expect(resolved).toEqual({ kind: 'local' })
  })

  // The candidate FILTER decides which rows reach the resolver, and it read `repo.connectionId` raw
  // too — so an SSH-only repo outside the project-group subtree was dropped before any of the above
  // could classify it. Every test before this one uses a repo inside the subtree, which is never
  // filtered, so none of them could have caught it (found in review by CodeRabbit).
  describe('a repo matched only by path, outside the project-group subtree', () => {
    const sshOnlyPathRepo = repo({
      id: 'repo-path',
      path: '/work/app/nested',
      executionHostId: 'ssh:box'
    })

    it('survives the scope-connection filter instead of being dropped as connectionless', () => {
      const scoped = state({
        folderWorkspaces: [workspace({ connectionId: 'box' })],
        repos: [sshOnlyPathRepo]
      })

      expect(findFolderWorkspaceCandidateRepos(scoped, 'fw-1')).toEqual([sshOnlyPathRepo])
      expect(resolveFolderWorkspaceHost(scoped, 'fw-1')).toEqual({ kind: 'ssh', targetId: 'box' })
    })

    // Pins the resolver, not the filter: under the old raw read BOTH rows came back connectionless,
    // so they matched each other by accident and this case survived the filter either way. The
    // legacy-vs-unified pairing below is the one that discriminates.
    it('survives the group-connection filter when the group is on that same SSH host', () => {
      const scoped = state({
        repos: [
          repo({
            id: 'repo-group',
            path: '/work/app/group',
            projectGroupId: 'group-1',
            executionHostId: 'ssh:box'
          }),
          sshOnlyPathRepo
        ]
      })

      expect(findFolderWorkspaceCandidateRepos(scoped, 'fw-1')).toHaveLength(2)
      expect(resolveFolderWorkspaceHost(scoped, 'fw-1')).toEqual({ kind: 'ssh', targetId: 'box' })
    })

    // Both sides of the group comparison are resolved, so the legacy spelling on one side and the
    // unified spelling on the other still match.
    it('matches a legacy-spelled group repo against a unified-spelled path repo', () => {
      const scoped = state({
        repos: [
          repo({
            id: 'repo-group',
            path: '/work/app/group',
            projectGroupId: 'group-1',
            connectionId: 'box'
          }),
          sshOnlyPathRepo
        ]
      })

      expect(findFolderWorkspaceCandidateRepos(scoped, 'fw-1')).toHaveLength(2)
      expect(resolveFolderWorkspaceHost(scoped, 'fw-1')).toEqual({ kind: 'ssh', targetId: 'box' })
    })

    // A `runtime:` row's nested target is still read from the raw field, so it matches a scope
    // connection exactly as it does today. Pinned so the carve-out stays a decision.
    it('leaves a runtime row matching the scope connection through its nested target', () => {
      const runtimePathRepo = repo({
        id: 'repo-path',
        path: '/work/app/nested',
        executionHostId: 'runtime:env-1',
        connectionId: 'box'
      })
      const scoped = state({
        folderWorkspaces: [workspace({ connectionId: 'box' })],
        repos: [runtimePathRepo]
      })

      expect(findFolderWorkspaceCandidateRepos(scoped, 'fw-1')).toEqual([runtimePathRepo])
    })
  })

  it('reads each repository membership once while collecting candidates', () => {
    let membershipReads = 0
    const repos = Array.from({ length: 32 }, (_, index) => {
      const candidate = repo({
        id: ['repo', index].join('-'),
        path: ['/elsewhere', index].join('/')
      })
      Object.defineProperty(candidate, 'projectGroupId', {
        configurable: true,
        get: () => {
          membershipReads += 1
          return undefined
        }
      })
      return candidate
    })

    expect(findFolderWorkspaceCandidateRepos(state({ repos }), 'fw-1')).toEqual([])
    expect(membershipReads).toBe(repos.length)
  })
})

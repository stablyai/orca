/**
 * The pin cases are the ones that used to diverge: main resolved the repo and
 * said local while the renderer resolved the workspace and said SSH.
 */

import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from './folder-workspace-types'
import type { ProjectGroup } from './project-group-types'
import type { Repo } from './repo-types'
import {
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
})

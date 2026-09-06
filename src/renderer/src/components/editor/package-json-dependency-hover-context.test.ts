import { describe, expect, it } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repo-types'
import type { OpenFile } from '@/store/slices/editor'
import {
  resolvePackageJsonHoverContext,
  type PackageJsonHoverStoreState
} from './package-json-dependency-hover-context'

const toModelUriString = (filePath: string): string => `file-uri:${filePath}`

function worktree(overrides: Partial<Worktree> & Pick<Worktree, 'id' | 'repoId'>): Worktree {
  return {
    path: '/repo',
    head: 'head',
    branch: 'main',
    isBare: false,
    isMainWorktree: true,
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  } as Worktree
}

function repo(overrides: Partial<Repo> & Pick<Repo, 'id'>): Repo {
  return {
    path: '/repo',
    displayName: overrides.id,
    badgeColor: '#000000',
    addedAt: 0,
    connectionId: null,
    ...overrides
  } as Repo
}

function openFile(
  overrides: Partial<OpenFile> & Pick<OpenFile, 'filePath' | 'worktreeId'>
): OpenFile {
  return {
    id: overrides.filePath,
    relativePath: 'package.json',
    language: 'json',
    isDirty: false,
    mode: 'edit',
    ...overrides
  } as OpenFile
}

function baseState(
  overrides: Partial<PackageJsonHoverStoreState> = {}
): PackageJsonHoverStoreState {
  return {
    openFiles: [],
    folderWorkspaces: [],
    projectGroups: [],
    repos: [repo({ id: 'repo-1', connectionId: null })],
    worktreesByRepo: { 'repo-1': [worktree({ id: 'repo-1::/repo', repoId: 'repo-1' })] },
    ...overrides
  }
}

describe('resolvePackageJsonHoverContext', () => {
  it('resolves the worktree root and host for the open file matching the rebuilt model URI', () => {
    const file = openFile({ filePath: '/repo/package.json', worktreeId: 'repo-1::/repo' })
    const state = baseState({ openFiles: [file] })

    const result = resolvePackageJsonHoverContext(
      state,
      toModelUriString('/repo/package.json'),
      toModelUriString
    )

    expect(result).toEqual({
      worktreeRoot: '/repo',
      relativePath: 'package.json',
      filePath: '/repo/package.json',
      worktreeId: 'repo-1::/repo',
      connectionId: null,
      executionHostId: 'local',
      runtimeEnvironmentId: undefined,
      externalSshTargetId: undefined
    })
  })

  it('returns undefined when no open file matches the model URI', () => {
    const file = openFile({ filePath: '/repo/other.json', worktreeId: 'repo-1::/repo' })
    const state = baseState({ openFiles: [file] })

    expect(
      resolvePackageJsonHoverContext(
        state,
        toModelUriString('/repo/package.json'),
        toModelUriString
      )
    ).toBeUndefined()
  })

  it('fails closed when the host cannot be resolved for the owning worktree', () => {
    const file = openFile({ filePath: '/repo/package.json', worktreeId: 'missing-worktree' })
    const state = baseState({ openFiles: [file], worktreesByRepo: {} })

    expect(
      resolvePackageJsonHoverContext(
        state,
        toModelUriString('/repo/package.json'),
        toModelUriString
      )
    ).toBeUndefined()
  })

  it('resolves an SSH host from the owning repo connection', () => {
    const file = openFile({ filePath: '/repo/package.json', worktreeId: 'repo-1::/repo' })
    const state = baseState({
      openFiles: [file],
      repos: [repo({ id: 'repo-1', connectionId: 'ssh-target' })]
    })

    const result = resolvePackageJsonHoverContext(
      state,
      toModelUriString('/repo/package.json'),
      toModelUriString
    )

    expect(result?.connectionId).toBe('ssh-target')
    expect(result?.executionHostId).toBe('ssh:ssh-target')
  })
})

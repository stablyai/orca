// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { useWorktreeCardFoundation } from './use-worktree-card-foundation'

const initialState = useAppStore.getInitialState()

const localRepo = {
  id: 'local-repo',
  path: '/tmp/local-repo',
  displayName: 'local-repo',
  badgeColor: '#111',
  addedAt: 1,
  executionHostId: 'local'
} as Repo

const remoteRepo = {
  ...localRepo,
  id: 'remote-repo',
  path: '/tmp/remote-repo',
  executionHostId: 'runtime:work'
} as Repo

const localWorktree = {
  id: 'local-repo::/tmp/local-repo',
  repoId: localRepo.id,
  path: localRepo.path,
  displayName: localRepo.displayName,
  branch: 'refs/heads/main',
  head: 'abc123',
  isBare: false,
  isMainWorktree: true,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  hostId: 'local'
} as Worktree

describe('worktree card project group host label', () => {
  beforeEach(() => {
    useAppStore.setState(initialState, true)
  })

  afterEach(() => {
    cleanup()
    useAppStore.setState(initialState, true)
  })

  it('stays generic when the host filter hides the other catalog', () => {
    useAppStore.setState({
      repos: [localRepo, remoteRepo],
      visibleWorkspaceHostIds: ['local'],
      workspaceHostScope: 'all'
    })

    const { result } = renderHook(() =>
      useWorktreeCardFoundation({ worktree: localWorktree, repo: localRepo })
    )

    expect(result.current.projectGroupHostLabel).toBeUndefined()
  })

  it('uses the worktree owner when duplicate repo ids point at another host', () => {
    const duplicateLocalRepo = { ...localRepo, id: 'shared-repo' }
    const duplicateRemoteRepo = { ...remoteRepo, id: 'shared-repo' }
    const remoteWorktree = {
      ...localWorktree,
      id: 'shared-repo::/tmp/remote-repo',
      repoId: 'shared-repo',
      hostId: 'ssh:air',
      runtimeOwnerEnvironmentId: 'work'
    } as Worktree
    const localDuplicateWorktree = {
      ...localWorktree,
      id: 'shared-repo::/tmp/local-repo',
      repoId: 'shared-repo'
    } as Worktree
    useAppStore.setState({
      repos: [duplicateRemoteRepo, duplicateLocalRepo],
      runtimeEnvironments: [{ id: 'work', name: 'Work' }] as never,
      visibleWorkspaceHostIds: null,
      workspaceHostScope: 'all'
    })

    const remote = renderHook(() =>
      useWorktreeCardFoundation({ worktree: remoteWorktree, repo: duplicateLocalRepo })
    )
    expect(remote.result.current.projectGroupHostLabel).toBe('Work')
    remote.unmount()

    const local = renderHook(() =>
      useWorktreeCardFoundation({
        worktree: localDuplicateWorktree,
        repo: duplicateRemoteRepo
      })
    )
    expect(local.result.current.projectGroupHostLabel).toBe('Local')
  })
})

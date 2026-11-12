import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import { TEST_SSH_AUTHORITY, makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  listKnownForExecutionHostMock,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    clearHugeRepoWarningDismissalsForTests()
  })

  it('drops metadata rows when SSH authority lands during the read', async () => {
    const store = createTestStore()
    const sshRepo = {
      id: 'repo-ssh',
      path: '/home/orca/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    const live = makeWorktree({
      id: 'repo-ssh::/home/orca/live',
      repoId: 'repo-ssh',
      path: '/home/orca/live',
      hostId: 'ssh:ssh-1'
    })
    // Why: deleted on the host, so an authoritative scan already purged it; the late metadata write must not resurrect it.
    const purged = makeWorktree({
      id: 'repo-ssh::/home/orca/purged',
      repoId: 'repo-ssh',
      path: '/home/orca/purged'
    })
    listKnownForExecutionHostMock.mockImplementationOnce(async (args) => {
      store.setState({
        sshConnectionStates: new Map([
          [
            TEST_SSH_AUTHORITY.targetId,
            {
              targetId: TEST_SSH_AUTHORITY.targetId,
              status: 'connected',
              error: null,
              reconnectAttempt: 0,
              providerEpoch: TEST_SSH_AUTHORITY.providerEpoch,
              connectionGeneration: TEST_SSH_AUTHORITY.connectionGeneration
            }
          ]
        ]),
        worktreesByRepo: { [sshRepo.id]: [live] }
      } as Partial<AppState>)
      return {
        status: 'complete',
        repoId: args.repoId,
        executionHostId: args.executionHostId,
        result: makeDetectedResult(args.repoId, [live, purged], {
          authoritative: false,
          source: 'metadata-fallback'
        })
      }
    })
    store.setState({
      repos: [sshRepo],
      sshConnectionStates: new Map()
    } as Partial<AppState>)

    await store.getState().fetchWorktrees(sshRepo.id)

    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([live])
  })

  it('does not resurrect worktrees an authoritative SSH scan already removed', async () => {
    const store = createTestStore()
    const sshRepo = {
      id: 'repo-ssh',
      path: '/home/orca/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    const live = makeWorktree({
      id: 'repo-ssh::/home/orca/live',
      repoId: 'repo-ssh',
      path: '/home/orca/live',
      hostId: 'ssh:ssh-1'
    })
    const deletedOnRemote = makeWorktree({
      id: 'repo-ssh::/home/orca/deleted',
      repoId: 'repo-ssh',
      path: '/home/orca/deleted'
    })
    const metadataResult = () => ({
      status: 'complete' as const,
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1' as const,
      result: makeDetectedResult(sshRepo.id, [deletedOnRemote], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    })
    const connectedStates = createTestStore().getState().sshConnectionStates
    listKnownForExecutionHostMock.mockResolvedValueOnce(metadataResult())
    store.setState({ repos: [sshRepo], sshConnectionStates: new Map() } as Partial<AppState>)

    await store.getState().fetchWorktrees(sshRepo.id)
    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([
      { ...deletedOnRemote, hostId: 'ssh:ssh-1' }
    ])

    // The host connects and an authoritative scan proves the worktree is gone.
    worktreeListMock.mockResolvedValueOnce([live])
    store.setState({ sshConnectionStates: connectedStates } as Partial<AppState>)
    await store.getState().fetchWorktrees(sshRepo.id)
    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([live])

    // The host drops again; persisted metadata still lists the deleted worktree.
    listKnownForExecutionHostMock.mockResolvedValueOnce(metadataResult())
    store.setState({ sshConnectionStates: new Map() } as Partial<AppState>)
    await store.getState().fetchWorktrees(sshRepo.id)

    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([live])
  })
})

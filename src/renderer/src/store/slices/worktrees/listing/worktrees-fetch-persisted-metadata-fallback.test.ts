import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../../shared/execution-host'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import { TEST_SSH_AUTHORITY, makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  listKnownForExecutionHostMock,
  mockApi,
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

  it('adds metadata rows without replacing richer cached SSH worktrees', async () => {
    const store = createTestStore()
    const sshRepo = {
      id: 'repo-ssh',
      path: '/home/orca/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    const existing = makeWorktree({
      id: 'repo-ssh::/home/orca/existing',
      repoId: 'repo-ssh',
      path: '/home/orca/existing',
      hostId: 'ssh:ssh-1',
      head: 'live-head',
      branch: 'refs/heads/live-branch'
    })
    const metadataExisting = { ...existing, head: '', branch: '' }
    const queued = makeWorktree({
      id: 'repo-ssh::/home/orca/queued',
      repoId: 'repo-ssh',
      path: '/home/orca/queued'
    })
    listKnownForExecutionHostMock.mockResolvedValueOnce({
      status: 'complete',
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1',
      result: makeDetectedResult('repo-ssh', [metadataExisting, queued], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    })
    store.setState({
      repos: [sshRepo],
      sshConnectionStates: new Map(),
      worktreesByRepo: { [sshRepo.id]: [existing] }
    } as Partial<AppState>)

    await store.getState().fetchWorktrees(sshRepo.id)

    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([
      existing,
      { ...queued, hostId: 'ssh:ssh-1' }
    ])
  })

  it('inserts metadata rows inside the SSH block instead of past sibling hosts', async () => {
    const store = createTestStore()
    const sshRepo = {
      id: 'repo-shared',
      path: '/home/orca/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    const localRepo = { ...sshRepo, path: '/local/repo', connectionId: undefined }
    const sshExisting = makeWorktree({
      id: 'repo-shared::/home/orca/existing',
      repoId: sshRepo.id,
      path: '/home/orca/existing',
      hostId: 'ssh:ssh-1'
    })
    const localExisting = makeWorktree({
      id: 'repo-shared::/local/existing',
      repoId: sshRepo.id,
      path: '/local/existing',
      hostId: LOCAL_EXECUTION_HOST_ID
    })
    const queued = makeWorktree({
      id: 'repo-shared::/home/orca/queued',
      repoId: sshRepo.id,
      path: '/home/orca/queued'
    })
    listKnownForExecutionHostMock.mockResolvedValueOnce({
      status: 'complete',
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1',
      result: makeDetectedResult(sshRepo.id, [queued], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    })
    store.setState({
      repos: [sshRepo, localRepo],
      sshConnectionStates: new Map(),
      worktreesByRepo: { [sshRepo.id]: [sshExisting, localExisting] }
    } as Partial<AppState>)

    await store.getState().fetchWorktrees(sshRepo.id, { executionHostId: 'ssh:ssh-1' })

    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([
      sshExisting,
      { ...queued, hostId: 'ssh:ssh-1' },
      localExisting
    ])
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

  it('keeps the repo detection entry authoritative while appending metadata rows', async () => {
    const store = createTestStore()
    const sshRepo = {
      id: 'repo-shared',
      path: '/home/orca/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    const localRepo = { ...sshRepo, path: '/local/repo', connectionId: undefined }
    const scanned = makeWorktree({
      id: 'repo-shared::/local/scanned',
      repoId: sshRepo.id,
      path: '/local/scanned'
    })
    const fromMetadata = makeWorktree({
      id: 'repo-shared::/home/orca/queued',
      repoId: sshRepo.id,
      path: '/home/orca/queued'
    })
    const authoritative = makeDetectedResult(sshRepo.id, [scanned])
    listKnownForExecutionHostMock.mockResolvedValueOnce({
      status: 'complete',
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1',
      result: makeDetectedResult(sshRepo.id, [fromMetadata], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    })
    store.setState({
      repos: [sshRepo, localRepo],
      sshConnectionStates: new Map(),
      detectedWorktreesByRepo: { [sshRepo.id]: authoritative }
    } as Partial<AppState>)

    await store.getState().fetchWorktrees(sshRepo.id, { executionHostId: 'ssh:ssh-1' })

    const detected = store.getState().detectedWorktreesByRepo[sshRepo.id]
    // Why: this entry is shared with the co-owning local host, so the fallback must not demote its scan.
    expect(detected?.authoritative).toBe(true)
    expect(detected?.source).toBe('git')
    expect(detected?.worktrees.map((worktree) => worktree.id)).toEqual([
      scanned.id,
      fromMetadata.id
    ])
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

  it('skips the metadata fallback entirely for authoritative-only callers', async () => {
    const store = createTestStore()
    const sshRepo = {
      id: 'repo-ssh',
      path: '/home/orca/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    store.setState({ repos: [sshRepo], sshConnectionStates: new Map() } as Partial<AppState>)
    const worktreesByRepo = store.getState().worktreesByRepo
    const detectedWorktreesByRepo = store.getState().detectedWorktreesByRepo

    await expect(
      store.getState().fetchWorktrees(sshRepo.id, { requireAuthoritative: true })
    ).resolves.toBe(false)

    // Why: these callers asked for authoritative-or-nothing; non-authoritative rows must not land as a side effect.
    expect(listKnownForExecutionHostMock).not.toHaveBeenCalled()
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo).toBe(worktreesByRepo)
    expect(store.getState().detectedWorktreesByRepo).toBe(detectedWorktreesByRepo)
  })
})

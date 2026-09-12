import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import type {
  HostQualifiedDetectedWorktreeResult,
  ListDetectedWorktreesArgs
} from '../../../../shared/detected-worktree-provider-contract'
import type { SshProviderEpoch } from '../../../../shared/ssh-types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control-huge-repo-warning-dismissals'
import { acquireDirectSshDetectedWorktreeRefresh } from './worktrees'
import {
  TEST_SSH_AUTHORITY,
  makeDetectedResult,
  qualifyDetectedResult
} from './worktrees-detected-listing-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  forgetRemovedForExecutionHostMock,
  listKnownForExecutionHostMock,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
} from './worktrees-slice-test-harness'

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

  it('shows persisted secondary worktrees while SSH is connecting', async () => {
    const store = createTestStore()
    const sshRepo = {
      id: 'repo-ssh',
      path: '/home/orca/repo',
      displayName: 'SSH Repo',
      badgeColor: '#000',
      addedAt: 0,
      connectionId: 'ssh-1'
    }
    const queued = makeWorktree({
      id: 'repo-ssh::/home/orca/queued',
      repoId: 'repo-ssh',
      path: '/home/orca/queued',
      displayName: 'queued'
    })
    const detected = makeDetectedResult('repo-ssh', [queued], {
      authoritative: false,
      source: 'metadata-fallback'
    })
    listKnownForExecutionHostMock.mockResolvedValueOnce({
      status: 'complete',
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1',
      result: detected
    })
    store.setState({
      repos: [sshRepo],
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connecting',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: null
          }
        ]
      ])
    } as Partial<AppState>)

    await expect(store.getState().fetchWorktrees(sshRepo.id)).resolves.toBe(false)

    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([
      { ...queued, hostId: 'ssh:ssh-1' }
    ])
    expect(listKnownForExecutionHostMock).toHaveBeenCalledWith({
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1'
    })
    expect(mockApi.worktrees.listDetected).not.toHaveBeenCalled()
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

  it('replaces metadata rows once the authoritative SSH scan lands', async () => {
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
    const stale = makeWorktree({
      id: 'repo-ssh::/home/orca/stale',
      repoId: 'repo-ssh',
      path: '/home/orca/stale'
    })
    listKnownForExecutionHostMock.mockResolvedValueOnce({
      status: 'complete',
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1',
      result: makeDetectedResult(sshRepo.id, [stale], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    })
    const connectedStates = createTestStore().getState().sshConnectionStates
    store.setState({ repos: [sshRepo], sshConnectionStates: new Map() } as Partial<AppState>)

    await store.getState().fetchWorktrees(sshRepo.id)
    expect(store.getState().worktreesByRepo[sshRepo.id]).toEqual([
      { ...stale, hostId: 'ssh:ssh-1' }
    ])

    worktreeListMock.mockResolvedValueOnce([live])
    store.setState({ sshConnectionStates: connectedStates } as Partial<AppState>)
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

  it('retires persisted metadata for worktrees an authoritative SSH scan proved gone', async () => {
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
    const connectedStates = createTestStore().getState().sshConnectionStates
    listKnownForExecutionHostMock.mockResolvedValueOnce({
      status: 'complete',
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1',
      result: makeDetectedResult(sshRepo.id, [deletedOnRemote], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    })
    store.setState({ repos: [sshRepo], sshConnectionStates: new Map() } as Partial<AppState>)
    await store.getState().fetchWorktrees(sshRepo.id)

    // The non-authoritative fallback saw the same absence but must not act on it.
    expect(forgetRemovedForExecutionHostMock).not.toHaveBeenCalled()

    worktreeListMock.mockResolvedValueOnce([live])
    store.setState({ sshConnectionStates: connectedStates } as Partial<AppState>)
    await store.getState().fetchWorktrees(sshRepo.id)

    // Why: the renderer's suppression memory dies with the reload, so the metadata itself has to go.
    expect(forgetRemovedForExecutionHostMock).toHaveBeenCalledExactlyOnceWith({
      repoId: sshRepo.id,
      executionHostId: 'ssh:ssh-1',
      worktreeIds: [deletedOnRemote.id]
    })
  })

  it('leaves local metadata to the persistence GC after an authoritative local scan', async () => {
    const store = createTestStore()
    const localRepo = {
      id: 'repo-local',
      path: '/local/repo',
      displayName: 'Local Repo',
      badgeColor: '#000',
      addedAt: 0
    }
    const removed = makeWorktree({
      id: 'repo-local::/local/removed',
      repoId: localRepo.id,
      path: '/local/removed'
    })
    const survivor = makeWorktree({
      id: 'repo-local::/local/survivor',
      repoId: localRepo.id,
      path: '/local/survivor'
    })
    store.setState({
      repos: [localRepo],
      worktreesByRepo: { [localRepo.id]: [removed, survivor] }
    } as Partial<AppState>)
    worktreeListMock.mockResolvedValueOnce([survivor])

    await store.getState().fetchWorktrees(localRepo.id)

    expect(store.getState().worktreesByRepo[localRepo.id]).toEqual([survivor])
    // Local metas are GC-eligible on their own; only the SSH exemption needs this IPC.
    expect(forgetRemovedForExecutionHostMock).not.toHaveBeenCalled()
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

  it('keeps worktree maps byte-identical for stale and malformed direct results', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo-ssh::/home/orca/existing',
      repoId: 'repo-ssh',
      path: '/home/orca/existing',
      hostId: 'ssh:ssh-1'
    })
    store.setState({
      repos: [
        {
          id: 'repo-ssh',
          path: '/home/orca/repo',
          displayName: 'SSH Repo',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { 'repo-ssh': [existing] },
      detectedWorktreesByRepo: {
        'repo-ssh': makeDetectedResult('repo-ssh', [existing])
      }
    } as Partial<AppState>)
    const beforeWorktrees = store.getState().worktreesByRepo
    const beforeDetected = store.getState().detectedWorktreesByRepo
    const beforeBytes = JSON.stringify([beforeWorktrees, beforeDetected])
    let request!: ListDetectedWorktreesArgs
    let resolveProvider!: (result: HostQualifiedDetectedWorktreeResult) => void
    mockApi.worktrees.listDetected.mockImplementationOnce(
      async (args: ListDetectedWorktreesArgs) => {
        request = args
        return new Promise<HostQualifiedDetectedWorktreeResult>((resolve) => {
          resolveProvider = resolve
        })
      }
    )
    const lease = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'repo-ssh',
      executionHostId: 'ssh:ssh-1',
      authority: TEST_SSH_AUTHORITY
    })
    const nextAuthority = {
      ...TEST_SSH_AUTHORITY,
      providerEpoch: 'provider-ssh-2' as SshProviderEpoch,
      connectionGeneration: 2
    }
    store.setState({
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: nextAuthority.providerEpoch,
            connectionGeneration: nextAuthority.connectionGeneration
          }
        ]
      ])
    } as Partial<AppState>)
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)
    resolveProvider(
      qualifyDetectedResult(
        request,
        makeDetectedResult('repo-ssh', [
          makeWorktree({
            id: 'repo-ssh::/home/orca/stale',
            repoId: 'repo-ssh',
            path: '/home/orca/stale'
          })
        ])
      )
    )
    const staleResult = await lease.result

    expect(lease.merge(staleResult)).toMatchObject({ status: 'stale' })
    expect(store.getState().worktreesByRepo).toBe(beforeWorktrees)
    expect(store.getState().detectedWorktreesByRepo).toBe(beforeDetected)
    expect(JSON.stringify([beforeWorktrees, beforeDetected])).toBe(beforeBytes)
    expect(subscriber).not.toHaveBeenCalled()
    unsubscribe()

    store.setState({
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: nextAuthority.providerEpoch,
            connectionGeneration: nextAuthority.connectionGeneration
          }
        ]
      ])
    } as Partial<AppState>)
    mockApi.worktrees.listDetected.mockImplementationOnce(
      async (args: ListDetectedWorktreesArgs) => ({
        ...qualifyDetectedResult(args, makeDetectedResult(args.repoId, [])),
        repoId: 'wrong-repo'
      })
    )
    const malformed = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'repo-ssh',
      executionHostId: 'ssh:ssh-1',
      authority: nextAuthority
    })
    const malformedResult = await malformed.result

    expect(malformed.merge(malformedResult)).toMatchObject({
      status: 'rejected'
    })
    expect(store.getState().worktreesByRepo).toBe(beforeWorktrees)
    expect(store.getState().detectedWorktreesByRepo).toBe(beforeDetected)
  })

  it('keeps duplicate repo IDs isolated across direct SSH hosts', async () => {
    const store = createTestStore()
    const authorityA = {
      targetId: 'ssh-a',
      providerEpoch: 'provider-a' as SshProviderEpoch,
      connectionGeneration: 1
    }
    const authorityB = {
      targetId: 'ssh-b',
      providerEpoch: 'provider-b' as SshProviderEpoch,
      connectionGeneration: 4
    }
    const worktreeA = makeWorktree({
      id: 'same-repo::/srv/a',
      repoId: 'same-repo',
      path: '/srv/a'
    })
    const worktreeB = makeWorktree({
      id: 'same-repo::/srv/b',
      repoId: 'same-repo',
      path: '/srv/b'
    })
    store.setState({
      repos: [
        {
          id: 'same-repo',
          path: '/srv/repo-a',
          displayName: 'Repo A',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-a'
        },
        {
          id: 'same-repo',
          path: '/srv/repo-b',
          displayName: 'Repo B',
          badgeColor: '#111',
          addedAt: 1,
          connectionId: 'ssh-b'
        }
      ],
      sshConnectionStates: new Map([
        [
          'ssh-a',
          {
            targetId: 'ssh-a',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: authorityA.providerEpoch,
            connectionGeneration: authorityA.connectionGeneration
          }
        ],
        [
          'ssh-b',
          {
            targetId: 'ssh-b',
            status: 'connected',
            error: null,
            reconnectAttempt: 0,
            providerEpoch: authorityB.providerEpoch,
            connectionGeneration: authorityB.connectionGeneration
          }
        ]
      ])
    } as Partial<AppState>)
    mockApi.worktrees.listDetected
      .mockImplementationOnce(async (args: ListDetectedWorktreesArgs) =>
        qualifyDetectedResult(args, makeDetectedResult(args.repoId, [worktreeA]))
      )
      .mockImplementationOnce(async (args: ListDetectedWorktreesArgs) =>
        qualifyDetectedResult(args, makeDetectedResult(args.repoId, [worktreeB]))
      )

    const refreshA = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'same-repo',
      executionHostId: 'ssh:ssh-a',
      authority: authorityA
    })
    const refreshB = acquireDirectSshDetectedWorktreeRefresh(store, {
      repoId: 'same-repo',
      executionHostId: 'ssh:ssh-b',
      authority: authorityB
    })
    refreshA.merge(await refreshA.result)
    refreshB.merge(await refreshB.result)

    expect(mockApi.worktrees.listDetected).toHaveBeenCalledTimes(2)
    expect(refreshA.providerRequestId).not.toBe(refreshB.providerRequestId)
    expect(store.getState().worktreesByRepo['same-repo']).toEqual([
      { ...worktreeA, hostId: 'ssh:ssh-a' },
      { ...worktreeB, hostId: 'ssh:ssh-b' }
    ])
  })
})

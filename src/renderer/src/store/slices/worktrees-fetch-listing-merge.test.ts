import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { Worktree } from '../../../../shared/worktree/types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control-huge-repo-warning-dismissals'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
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

  it('does not notify subscribers when the fetched payload is unchanged', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const subscriber = vi.fn()
    const detected = makeDetectedResult('repo1', [existing])

    mockApi.worktrees.listDetected.mockResolvedValueOnce(detected)
    store.setState({
      worktreesByRepo: { repo1: [existing] },
      detectedWorktreesByRepo: { repo1: detected },
      sortEpoch: 7
    } as Partial<AppState>)

    const unsubscribe = store.subscribe(subscriber)
    const result = await store.getState().fetchWorktrees('repo1')
    unsubscribe()

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(subscriber).not.toHaveBeenCalled()
    expect(result).toBe(true)
  })

  it('retains catalog and row references for a cloned unchanged runtime payload', async () => {
    const store = createTestStore()
    const first = makeWorktree({
      id: 'repo1::/path/first',
      repoId: 'repo1',
      path: '/path/first',
      createdAt: 123,
      sparsePresetId: 'preset-1',
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature',
        remoteCreated: true
      },
      cliProvenance: {
        kind: 'created-by-cli',
        createdAt: 123,
        callerTerminalHandle: 'term-1',
        startupAgent: 'codex'
      }
    })
    const second = makeWorktree({
      id: 'repo1::/path/second',
      repoId: 'repo1',
      path: '/path/second'
    })
    const detected = makeDetectedResult('repo1', [first, second])
    store.setState({
      worktreesByRepo: { repo1: [first, second] },
      detectedWorktreesByRepo: { repo1: detected },
      sortEpoch: 7
    } as Partial<AppState>)
    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      structuredClone(makeDetectedResult('repo1', [first, second]))
    )
    const before = store.getState()
    const subscriber = vi.fn()
    const unsubscribe = store.subscribe(subscriber)

    await store.getState().fetchWorktrees('repo1')
    unsubscribe()

    const after = store.getState()
    expect(after.worktreesByRepo).toBe(before.worktreesByRepo)
    expect(after.worktreesByRepo.repo1).toBe(before.worktreesByRepo.repo1)
    expect(after.detectedWorktreesByRepo).toBe(before.detectedWorktreesByRepo)
    expect(after.detectedWorktreesByRepo.repo1).toBe(before.detectedWorktreesByRepo.repo1)
    expect(after.sortEpoch).toBe(7)
    expect(subscriber).not.toHaveBeenCalled()
  })

  it('reuses unaffected catalog rows while publishing a previously untracked field change', async () => {
    const store = createTestStore()
    const changed = makeWorktree({
      id: 'repo1::/path/changed',
      repoId: 'repo1',
      path: '/path/changed',
      pushTarget: { remoteName: 'origin', branchName: 'feature', remoteCreated: false }
    })
    const stable = makeWorktree({
      id: 'repo1::/path/stable',
      repoId: 'repo1',
      path: '/path/stable'
    })
    const detected = makeDetectedResult('repo1', [changed, stable])
    store.setState({
      worktreesByRepo: { repo1: [changed, stable] },
      detectedWorktreesByRepo: { repo1: detected },
      sortEpoch: 7
    } as Partial<AppState>)
    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [
        { ...changed, pushTarget: { ...changed.pushTarget!, remoteCreated: true } },
        { ...stable }
      ])
    )

    await store.getState().fetchWorktrees('repo1')

    const after = store.getState()
    expect(after.worktreesByRepo.repo1[0]).not.toBe(changed)
    expect(after.worktreesByRepo.repo1[0].pushTarget?.remoteCreated).toBe(true)
    expect(after.worktreesByRepo.repo1[1]).toBe(stable)
    expect(after.detectedWorktreesByRepo.repo1.worktrees[1]).toBe(detected.worktrees[1])
    expect(after.sortEpoch).toBe(8)
  })

  it('updates the repo entry and bumps sortEpoch when git reports a branch change', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-one',
      displayName: 'feature-one'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-two',
      head: 'def456',
      displayName: 'feature-two'
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('clears branch-scoped linked reviews when the listing observes a branch switch', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-one',
      linkedPR: 101,
      pushTarget: { remoteName: 'origin', branchName: 'feature-one' }
    })
    // Persisted metadata still carries the stale link when the listing refresh first observes the terminal branch switch.
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-two',
      head: 'def456',
      linkedPR: 101,
      pushTarget: { remoteName: 'origin', branchName: 'feature-one' }
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/feature-two',
      head: 'def456',
      linkedPR: null,
      pushTarget: undefined
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: 'repo1::/path/wt1',
      updates: expect.objectContaining({ linkedPR: null, pushTarget: undefined })
    })
  })

  it('does not merge a stale listing row over a newer branch and review link', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const requestStarted = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-one',
      head: 'first-head',
      linkedPR: 101
    })
    const staleResponse = makeWorktree({
      ...requestStarted,
      branch: 'refs/heads/feature-two',
      head: 'stale-head',
      linkedPR: 202
    })
    let resolveListing!: (worktrees: Worktree[]) => void
    const listing = new Promise<Worktree[]>((resolve) => {
      resolveListing = resolve
    })
    worktreeListMock.mockReturnValueOnce(listing)
    store.setState({ worktreesByRepo: { repo1: [requestStarted] } } as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(worktreeListMock).toHaveBeenCalledTimes(1))
    const latest = makeWorktree({
      ...requestStarted,
      branch: 'refs/heads/feature-three',
      head: 'latest-head',
      linkedPR: 303
    })
    store.setState({ worktreesByRepo: { repo1: [latest] } } as Partial<AppState>)
    resolveListing([staleResponse])

    await refresh

    expect(store.getState().worktreesByRepo.repo1).toEqual([latest])
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('does not merge stale manual order over a reorder completed during refresh', async () => {
    const store = createTestStore()
    const daily = makeWorktree({
      id: 'repo1::/path/daily',
      repoId: 'repo1',
      path: '/path/daily',
      manualOrder: 20
    })
    const relay = makeWorktree({
      id: 'repo1::/path/relay',
      repoId: 'repo1',
      path: '/path/relay',
      manualOrder: 10
    })
    const refreshedDaily = { ...daily, head: 'def456' }
    const detected = makeDetectedResult('repo1', [daily, relay])
    let resolveListing!: (worktrees: Worktree[]) => void
    const listing = new Promise<Worktree[]>((resolve) => {
      resolveListing = resolve
    })
    worktreeListMock.mockReturnValueOnce(listing)
    store.setState({
      worktreesByRepo: { repo1: [daily, relay] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(worktreeListMock).toHaveBeenCalledTimes(1))
    await store.getState().updateWorktreesMeta([
      { worktreeId: daily.id, updates: { manualOrder: 100 } },
      { worktreeId: relay.id, updates: { manualOrder: 200 } }
    ])
    resolveListing([refreshedDaily, relay])

    await refresh

    expect(store.getState().worktreesByRepo.repo1.map((worktree) => worktree.manualOrder)).toEqual([
      100, 200
    ])
    expect(
      store
        .getState()
        .detectedWorktreesByRepo.repo1.worktrees.map((worktree) => worktree.manualOrder)
    ).toEqual([100, 200])
    expect(store.getState().worktreesByRepo.repo1[0]?.head).toBe('def456')
  })

  it('does not merge a stale display name over a rename completed during refresh', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const requestStarted = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'old label',
      displayNameMode: 'fixed'
    })
    const staleResponse = makeWorktree({
      ...requestStarted,
      head: 'stale-head'
    })
    let resolveListing!: (worktrees: Worktree[]) => void
    const listing = new Promise<Worktree[]>((resolve) => {
      resolveListing = resolve
    })
    worktreeListMock.mockReturnValueOnce(listing)
    store.setState({ worktreesByRepo: { repo1: [requestStarted] } } as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(worktreeListMock).toHaveBeenCalledTimes(1))
    await store.getState().updateWorktreeMeta(worktreeId, { displayName: 'new label' })
    resolveListing([staleResponse])

    await refresh

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      head: 'stale-head',
      displayName: 'new label',
      displayNameMode: 'fixed'
    })
  })

  it('keeps a rename when an older host omits display-name mode', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const requestStarted = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'old label',
      displayNameMode: 'automatic'
    })
    const staleResponse = { ...requestStarted, displayNameMode: undefined }
    let resolveListing!: (worktrees: Worktree[]) => void
    worktreeListMock.mockReturnValueOnce(
      new Promise<Worktree[]>((resolve) => {
        resolveListing = resolve
      })
    )
    store.setState({ worktreesByRepo: { repo1: [requestStarted] } } as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(worktreeListMock).toHaveBeenCalledTimes(1))
    await store.getState().updateWorktreeMeta(worktreeId, { displayName: 'new label' })
    resolveListing([staleResponse])

    await refresh

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      displayName: 'new label',
      displayNameMode: 'fixed'
    })
  })

  it('keeps a rename when an old-host refresh is projected with a newer mode', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const requestStarted = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'old label',
      displayNameMode: undefined
    })
    const staleResponse = { ...requestStarted, displayNameMode: 'fixed' as const }
    let resolveListing!: (worktrees: Worktree[]) => void
    worktreeListMock.mockReturnValueOnce(
      new Promise<Worktree[]>((resolve) => {
        resolveListing = resolve
      })
    )
    store.setState({ worktreesByRepo: { repo1: [requestStarted] } } as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(worktreeListMock).toHaveBeenCalledTimes(1))
    await store.getState().updateWorktreeMeta(worktreeId, { displayName: 'new label' })
    resolveListing([staleResponse])

    await refresh

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      displayName: 'new label',
      displayNameMode: 'fixed'
    })
  })

  it('retains an existing pinned mode when an older host omits it', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'feature',
      displayNameMode: 'fixed'
    })
    const staleResponse = { ...existing, displayNameMode: undefined }

    mockApi.worktrees.list.mockResolvedValueOnce([staleResponse])
    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')
    store.getState().updateWorktreeGitIdentity(existing.id, { branch: 'refs/heads/next' })

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      displayName: 'feature',
      displayNameMode: 'fixed'
    })
  })

  it('accepts a peer rename from an older host over a pinned label', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'my label',
      displayNameMode: 'fixed'
    })
    // A changed non-branch label from a mode-less host is explicit meta a peer wrote there.
    const peerRenamed = { ...existing, displayName: 'peer label', displayNameMode: undefined }

    mockApi.worktrees.list.mockResolvedValueOnce([peerRenamed])
    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0].displayName).toBe('peer label')
  })

  it('suppresses an older host branch-derived relabel of a pinned name', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'my label',
      displayNameMode: 'fixed'
    })
    const rederived = {
      ...existing,
      branch: 'refs/heads/next',
      displayName: 'next',
      displayNameMode: undefined
    }

    mockApi.worktrees.list.mockResolvedValueOnce([rederived])
    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: 'refs/heads/next',
      displayName: 'my label',
      displayNameMode: 'fixed'
    })
  })

  it('suppresses an older host detached-HEAD path relabel of a pinned name', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: 'my label',
      displayNameMode: 'fixed'
    })
    const rederived = { ...existing, branch: '', displayName: 'wt1', displayNameMode: undefined }

    mockApi.worktrees.list.mockResolvedValueOnce([rederived])
    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      branch: '',
      displayName: 'my label',
      displayNameMode: 'fixed'
    })
  })

  it('does not merge a host response captured before an optimistic rename settles', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'old label',
      displayNameMode: 'automatic'
    })
    const staleResponse = { ...existing }
    let resolvePersist!: () => void
    mockApi.worktrees.updateMeta.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePersist = resolve
      })
    )
    mockApi.worktrees.list.mockResolvedValueOnce([staleResponse])
    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    const rename = store.getState().updateWorktreeMeta(existing.id, { displayName: 'new label' })
    await vi.waitFor(() => expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1))
    const refresh = store.getState().fetchWorktrees('repo1')

    await refresh
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      displayName: 'new label',
      displayNameMode: 'fixed'
    })

    resolvePersist()
    await rename
  })

  it('updates the repo entry when only the persisted base ref changes', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      baseRef: 'origin/main'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      baseRef: 'upstream/release'
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('updates the repo entry when only prior worktree id aliases change', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/current-name',
      repoId: 'repo1',
      path: '/path/current-name'
    })
    const refreshed = makeWorktree({
      id: 'repo1::/path/current-name',
      repoId: 'repo1',
      path: '/path/current-name',
      priorWorktreeIds: ['repo1::/path/old-name']
    })

    mockApi.worktrees.list.mockResolvedValue([refreshed])
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([refreshed])
    expect(store.getState().sortEpoch).toBe(8)
  })

  it('keeps the last known worktree list when a refresh transiently returns empty', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(result).toBe(false)
  })

  it('reports unchanged non-authoritative refreshes as not fully refreshed', async () => {
    const store = createTestStore()
    const existing = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [existing], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1')

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().sortEpoch).toBe(7)
    expect(result).toBe(false)
  })

  it('does not publish non-authoritative rows when an authoritative refresh is required', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/existing',
      repoId: 'repo1',
      path: '/path/existing'
    })
    const fallback = makeWorktree({
      id: 'repo1::/path/fallback',
      repoId: 'repo1',
      path: '/path/fallback'
    })

    mockApi.worktrees.listDetected.mockResolvedValueOnce(
      makeDetectedResult('repo1', [fallback], {
        authoritative: false,
        source: 'metadata-fallback'
      })
    )
    store.setState({ worktreesByRepo: { repo1: [existing] }, sortEpoch: 7 } as Partial<AppState>)

    const result = await store.getState().fetchWorktrees('repo1', { requireAuthoritative: true })

    expect(store.getState().worktreesByRepo.repo1).toEqual([existing])
    expect(store.getState().detectedWorktreesByRepo.repo1).toBeUndefined()
    expect(store.getState().sortEpoch).toBe(7)
    expect(result).toBe(false)
  })
})

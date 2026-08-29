import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
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

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('resolves and persists a push target when manually linking a GitHub PR', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'origin', branchName: 'bot/pr-bug-scan-2504' }
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({
      baseBranch: 'origin/bot/pr-bug-scan-2504',
      pushTarget
    })
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: LOCAL_EXECUTION_HOST_ID
        }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 2548 })

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 2548
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { linkedPR: 2548, pushTarget }
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('clears a stale push target when unlinking the GitHub PR that supplied it', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'fork', branchName: 'owner/old-pr' }
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedPR: 2548,
      pushTarget
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: null })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { linkedPR: null, pushTarget: undefined }
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toBeUndefined()
  })

  it('skips duplicate hosted-review work when the unlinking caller owns the refresh', async () => {
    const store = createTestStore()
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/review-branch',
      linkedPR: 2548,
      pushTarget: { remoteName: 'fork', branchName: 'owner/old-pr' }
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchHostedReviewForBranch
    } as Partial<AppState>)

    await store
      .getState()
      .updateWorktreeMeta(wt.id, { linkedPR: null }, { suppressHostedReviewRefresh: true })

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { linkedPR: null, pushTarget: undefined }
    })
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: null,
      pushTarget: undefined
    })
  })

  it('clears an older GitHub link and target when replacing it with a GitLab MR', async () => {
    const store = createTestStore()
    const oldPushTarget = { remoteName: 'fork', branchName: 'owner/old-pr' }
    const newPushTarget = { remoteName: 'upstream', branchName: 'owner/new-mr' }
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/review-branch',
      linkedPR: 2548,
      pushTarget: oldPushTarget
    })
    const fetchHostedReviewForBranch = vi.fn().mockResolvedValue(null)
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] },
      fetchHostedReviewForBranch
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedGitLabMR: 42 })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { linkedGitLabMR: 42, linkedPR: null, pushTarget: undefined }
    })
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: null,
      linkedGitLabMR: 42
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toBeUndefined()
    expect(fetchHostedReviewForBranch).toHaveBeenCalledWith('/repo1', 'review-branch', {
      repoId: 'repo1',
      repoOwnerExecutionHostId: 'local',
      linkedGitHubPR: null,
      linkedGitLabMR: 42,
      linkedBitbucketPR: null,
      linkedAzureDevOpsPR: null,
      linkedGiteaPR: null,
      force: true
    })

    mockApi.worktrees.updateMeta.mockClear()
    mockApi.worktrees.resolveMrBase.mockResolvedValueOnce({
      baseBranch: 'upstream/main',
      pushTarget: newPushTarget
    })

    await store.getState().ensureHostedReviewPushTarget(wt.id)

    expect(mockApi.worktrees.resolveMrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      mrIid: 42
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { pushTarget: newPushTarget }
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(newPushTarget)
  })

  it('resolves a manually linked GitHub PR through the worktree owner runtime', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'fork', branchName: 'owner-runtime/manual-pr' }
    const wt = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      hostId: 'runtime:owner-env'
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.resolvePrBase') {
        return Promise.resolve({
          id: 'rpc-owner-resolve-pr-base',
          ok: true,
          result: { baseBranch: 'fork-head', pushTarget },
          _meta: { runtimeId: 'owner-env' }
        })
      }
      if (method === 'worktree.set') {
        return Promise.resolve({
          id: 'rpc-owner-set-worktree',
          ok: true,
          result: { worktree: { ...wt, linkedPR: 2548, pushTarget } },
          _meta: { runtimeId: 'owner-env' }
        })
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 2548 })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'worktree.resolvePrBase',
      params: { repo: 'repo1', prNumber: 2548 },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'worktree.set',
      params: { worktree: `id:${wt.id}`, linkedPR: 2548, pushTarget },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('sends a runtime clear when unlinking a review-owned push target', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'fork', branchName: 'owner-runtime/old-pr' }
    const wt = makeWorktree({
      id: 'repo1::/remote/wt1',
      repoId: 'repo1',
      path: '/remote/wt1',
      hostId: 'runtime:owner-env',
      linkedPR: 2548,
      pushTarget
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.set') {
        return Promise.resolve({
          id: 'rpc-owner-clear-worktree',
          ok: true,
          result: { worktree: { ...wt, linkedPR: null, pushTarget: undefined } },
          _meta: { runtimeId: 'owner-env' }
        })
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: null })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'worktree.set',
      params: { worktree: `id:${wt.id}`, linkedPR: null, pushTarget: null },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toBeUndefined()
  })

  it('does not resolve a push target when metadata carries an invalid GitHub PR number', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 0 })

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { linkedPR: 0 }
    })
  })

  it('does not resolve a push target when re-saving the same linked GitHub PR', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'origin', branchName: 'bot/pr-bug-scan-2504' }
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedPR: 2548,
      pushTarget
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 2548 })

    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { linkedPR: 2548 }
    })
  })

  it('recovers a missing push target when re-saving the same linked GitHub PR', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'fork', branchName: 'contributor/fix' }
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedPR: 2548
    })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({
      baseBranch: 'origin/contributor/fix',
      pushTarget
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 2548 })

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 2548
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { linkedPR: 2548, pushTarget }
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('hydrates a missing push target for an existing linked GitHub PR', async () => {
    const store = createTestStore()
    const pushTarget = {
      remoteName: 'pr-tmchow-orca',
      branchName: 'tmchow/worktree-delete-button'
    }
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedPR: 5571
    })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({
      baseBranch: 'fork-head',
      pushTarget
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(wt.id)

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      prNumber: 5571
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { pushTarget }
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('hydrates a missing linked GitHub PR push target through the active remote runtime', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature/runtime-pr' }
    const wt = makeWorktree({
      id: 'repo1::/path/runtime-wt',
      repoId: 'repo1',
      path: '/path/runtime-wt',
      linkedPR: 5571
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.resolvePrBase') {
        return Promise.resolve({
          id: 'rpc-resolve-pr-base',
          ok: true,
          result: { baseBranch: 'fork-head', pushTarget },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      if (method === 'worktree.set') {
        return Promise.resolve({
          id: 'rpc-set-worktree',
          ok: true,
          result: { worktree: { ...wt, pushTarget } },
          _meta: { runtimeId: 'runtime-remote' }
        })
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(wt.id)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.resolvePrBase',
      params: { repo: 'repo1', prNumber: 5571 },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.set',
      params: { worktree: `id:${wt.id}`, pushTarget },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('hydrates a host-stamped linked GitHub PR push target through the worktree owner runtime', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature/owner-runtime-pr' }
    const wt = makeWorktree({
      id: 'repo1::/path/owner-runtime-wt',
      repoId: 'repo1',
      path: '/path/owner-runtime-wt',
      hostId: 'runtime:owner-env',
      linkedPR: 5571
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.resolvePrBase') {
        return Promise.resolve({
          id: 'rpc-owner-resolve-pr-base',
          ok: true,
          result: { baseBranch: 'fork-head', pushTarget },
          _meta: { runtimeId: 'owner-env' }
        })
      }
      if (method === 'worktree.set') {
        return Promise.resolve({
          id: 'rpc-owner-set-worktree',
          ok: true,
          result: { worktree: { ...wt, pushTarget } },
          _meta: { runtimeId: 'owner-env' }
        })
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'focused-env' } as never,
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(wt.id)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'worktree.resolvePrBase',
      params: { repo: 'repo1', prNumber: 5571 },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'owner-env',
      method: 'worktree.set',
      params: { worktree: `id:${wt.id}`, pushTarget },
      timeoutMs: 15_000
    })
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('hydrates an SSH-owned linked GitHub PR push target through local IPC when a runtime is focused', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'fork', branchName: 'feature/ssh-pr' }
    const wt = makeWorktree({
      id: 'repo-ssh::/home/orca/runtime-wt',
      repoId: 'repo-ssh',
      path: '/home/orca/runtime-wt',
      linkedPR: 5571,
      hostId: 'ssh:ssh-1'
    })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({
      baseBranch: 'fork-head',
      pushTarget
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
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
      worktreesByRepo: { 'repo-ssh': [wt] }
    } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(wt.id)

    expect(mockApi.worktrees.resolvePrBase).toHaveBeenCalledWith({
      repoId: 'repo-ssh',
      prNumber: 5571
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { pushTarget }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-ssh'][0]?.pushTarget).toEqual(pushTarget)
  })

  it('keeps a linked review without a derivable target unmodified', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedPR: 5571
    })
    mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({ baseBranch: 'fork-head' })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(wt.id)

    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toBeUndefined()
  })

  it('skips the push-target lookup for a genuinely ambiguous owner instead of throwing past the { ok, error } contract', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'hub-c' } as never,
      worktreesByRepo: {
        'repo-shared': [
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-shared',
            hostId: 'ssh:ssh-a',
            runtimeOwnerEnvironmentId: 'hub-a'
          }),
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-shared',
            hostId: 'ssh:ssh-b',
            runtimeOwnerEnvironmentId: 'hub-b'
          })
        ]
      }
    } as Partial<AppState>)

    const result = await store.getState().updateWorktreeMeta(worktreeId, { linkedPR: 123 })

    // The ambiguous owner must surface as a graceful { ok: false }, not an uncaught rejection.
    expect(result.ok).toBe(false)
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
  it('updates only the explicitly selected owner when locators collide', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    const sshA = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'ssh:ssh-a',
      runtimeOwnerEnvironmentId: 'hub-a',
      comment: 'A'
    })
    const sshB = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'ssh:ssh-b',
      runtimeOwnerEnvironmentId: 'hub-b',
      comment: 'B'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-set-selected-owner',
      ok: true,
      result: { worktree: sshB },
      _meta: { runtimeId: 'hub-b' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'hub-a' } as never,
      worktreesByRepo: { 'repo-shared': [sshA, sshB] }
    } as Partial<AppState>)

    const result = await store
      .getState()
      .updateWorktreeMeta(worktreeId, { comment: 'selected B' }, { executionHostId: 'ssh:ssh-b' })

    expect(result).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo['repo-shared']).toEqual([
      expect.objectContaining({ hostId: 'ssh:ssh-a', comment: 'A' }),
      expect.objectContaining({ hostId: 'ssh:ssh-b', comment: 'selected B' })
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'hub-b',
        method: 'worktree.set',
        params: expect.objectContaining({ comment: 'selected B' })
      })
    )
  })

  it('cleans up the in-flight lookup when restore is skipped for a genuinely ambiguous owner', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    const pushTarget = { remoteName: 'fork', branchName: 'feature/disambiguated' }
    const ownedWorktree = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'ssh:ssh-a',
      runtimeOwnerEnvironmentId: 'hub-a',
      linkedPR: 123
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.resolvePrBase') {
        return Promise.resolve({
          id: 'rpc-ambiguous-resolve-pr-base',
          ok: true,
          result: { baseBranch: 'fork-head', pushTarget },
          _meta: { runtimeId: 'hub-a' }
        })
      }
      if (method === 'worktree.set') {
        return Promise.resolve({
          id: 'rpc-ambiguous-set-worktree',
          ok: true,
          result: { worktree: { ...ownedWorktree, pushTarget } },
          _meta: { runtimeId: 'hub-a' }
        })
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'hub-c' } as never,
      worktreesByRepo: {
        'repo-shared': [
          ownedWorktree,
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-shared',
            hostId: 'ssh:ssh-b',
            runtimeOwnerEnvironmentId: 'hub-b',
            linkedPR: 123
          })
        ]
      }
    } as Partial<AppState>)

    await expect(store.getState().ensureHostedReviewPushTarget(worktreeId)).resolves.toBeUndefined()

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()

    // Drop the rival host row so the same lookup key now has one owner: a second call must run the
    // lookup for real, not silently no-op on a stale in-flight marker left by the skipped first call.
    store.setState({ worktreesByRepo: { 'repo-shared': [ownedWorktree] } } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(worktreeId)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'hub-a',
      method: 'worktree.resolvePrBase',
      params: { repo: 'repo-shared', prNumber: 123 },
      timeoutMs: 30_000
    })
    expect(store.getState().worktreesByRepo['repo-shared'][0]?.pushTarget).toEqual(pushTarget)
  })

  it('hydrates a missing push target for an existing linked GitLab MR when supported', async () => {
    const store = createTestStore()
    const pushTarget = { remoteName: 'upstream', branchName: 'feature/mr' }
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedGitLabMR: 42
    })
    mockApi.worktrees.resolveMrBase.mockResolvedValueOnce({
      baseBranch: 'upstream/feature/mr',
      pushTarget
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(wt.id)

    expect(mockApi.worktrees.resolveMrBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      mrIid: 42
    })
    expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith({
      worktreeId: wt.id,
      executionHostId: wt.hostId ?? 'local',
      updates: { pushTarget }
    })
    expect(store.getState().worktreesByRepo.repo1[0]?.pushTarget).toEqual(pushTarget)
  })

  it('skips push target hydration for invalid linked review numbers', async () => {
    const store = createTestStore()
    const github = makeWorktree({
      id: 'repo1::/path/github',
      repoId: 'repo1',
      path: '/path/github',
      linkedPR: 0
    })
    const gitlab = makeWorktree({
      id: 'repo1::/path/gitlab',
      repoId: 'repo1',
      path: '/path/gitlab',
      linkedGitLabMR: -1
    })
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [github, gitlab] }
    } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(github.id)
    await store.getState().ensureHostedReviewPushTarget(gitlab.id)

    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.resolveMrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })
})

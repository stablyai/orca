import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type { LocalBaseRefRefreshResult } from '../../../../shared/worktree/base-ref-drift-types'
import { toast } from 'sonner'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeWorkspaceLineage, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall,
  runtimeEnvironmentTransportCall
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

describe('createWorktree base status merge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('prefetches create base through desktop IPC on the local runtime target', async () => {
    const store = createTestStore()

    await store.getState().prefetchWorktreeCreateBase('repo1', 'origin/main')

    expect(mockApi.worktrees.prefetchCreateBase).toHaveBeenCalledWith({
      repoId: 'repo1',
      baseBranch: 'origin/main'
    })
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
  })

  it('prefetches create base through runtime RPC for remote runtime targets', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'remote-runtime' }
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockResolvedValue({ id: 'req', ok: true, result: null })

    await store.getState().prefetchWorktreeCreateBase('repo1')

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'remote-runtime',
      method: 'worktree.prefetchCreateBase',
      params: { repo: 'repo1' },
      timeoutMs: 30_000
    })
    expect(mockApi.worktrees.prefetchCreateBase).not.toHaveBeenCalled()
  })

  it('marks the create payload as a generated name only when the caller says so', async () => {
    // Why: the host retires generated names permanently, and the creature pool contains ordinary
    // words ("orca", "runner", "molly"). A name the user typed must stay reusable.
    const store = createTestStore()
    mockApi.worktrees.create.mockResolvedValue({
      worktree: makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    })

    await store.getState().createWorktree('repo1', 'nautilus', 'origin/main')
    expect(mockApi.worktrees.create.mock.calls[0][0]).not.toHaveProperty('nameWasGenerated')

    mockApi.worktrees.create.mockClear()
    await store
      .getState()
      .createWorktree(
        'repo1',
        'nautilus',
        'origin/main',
        'inherit',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { nameWasGenerated: true }
      )
    expect(mockApi.worktrees.create.mock.calls[0][0]).toMatchObject({ nameWasGenerated: true })
  })

  it('passes linked work item and creation agent metadata through the create IPC payload', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex',
      linkedLinearIssue: 'ENG-123',
      workspaceStatus: 'in-review',
      pendingFirstAgentMessageRename: true
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature',
        'origin/main',
        'inherit',
        undefined,
        'sidebar',
        'Feature Title',
        123,
        456,
        undefined,
        'codex',
        'ENG-123',
        undefined,
        'in-review',
        undefined,
        undefined,
        undefined,
        true
      )

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        name: 'feature',
        linkedIssue: 123,
        linkedPR: 456,
        createdWithAgent: 'codex',
        linkedLinearIssue: 'ENG-123',
        workspaceStatus: 'in-review',
        pendingFirstAgentMessageRename: true
      })
    )
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedIssue: 123,
      linkedPR: 456,
      createdWithAgent: 'codex',
      linkedLinearIssue: 'ENG-123',
      workspaceStatus: 'in-review',
      pendingFirstAgentMessageRename: true
    })
  })

  it('adopts an explicit provisioned root without calling ordinary worktree create', async () => {
    const store = createTestStore()
    const adopted = makeWorktree({
      id: 'repo1::/workspace/repo',
      repoId: 'repo1',
      path: '/workspace/repo',
      hostId: 'ssh:runtime-ssh-runtime-1',
      isMainWorktree: true,
      ephemeralVmCheckoutMode: 'provisioned-root'
    })
    mockApi.worktrees.adoptProvisionedRoot.mockResolvedValue({ worktree: adopted })

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature',
        undefined,
        'inherit',
        undefined,
        'sidebar',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          provisionedRoot: {
            runtimeId: 'runtime-1',
            executionHostId: 'ssh:runtime-ssh-runtime-1',
            expectedPath: '/workspace/repo'
          }
        }
      )

    expect(mockApi.worktrees.adoptProvisionedRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        runtimeId: 'runtime-1',
        executionHostId: 'ssh:runtime-ssh-runtime-1',
        expectedPath: '/workspace/repo'
      })
    )
    expect(mockApi.worktrees.create).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1).toContainEqual(
      expect.objectContaining({ id: adopted.id, ephemeralVmCheckoutMode: 'provisioned-root' })
    )
  })

  it('stamps the owning runtime host onto worktrees created on a remote runtime', async () => {
    const store = createTestStore()
    const created = makeWorktree({
      id: 'repo-remote::/remote/feature',
      repoId: 'repo-remote',
      path: '/remote/feature',
      // Why: the remote reports the worktree from its own perspective, so it comes back with the default local host.
      hostId: 'local'
    })
    store.setState({
      repos: [
        {
          id: 'repo-remote',
          path: '/home/dvic/src/omarchy-dotfiles',
          displayName: 'omarchy-dotfiles',
          badgeColor: '#000',
          addedAt: 0,
          executionHostId: 'runtime:env-1'
        }
      ]
    } as Partial<AppState>)
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) =>
      Promise.resolve({
        id: 'rpc-remote-create',
        ok: true,
        result: method === 'worktree.create' ? { worktree: created } : null,
        _meta: { runtimeId: 'runtime-remote' }
      })
    )

    await store.getState().createWorktree('repo-remote', 'feature', 'origin/main')

    expect(mockApi.worktrees.create).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo['repo-remote']?.[0]).toEqual({
      ...created,
      hostId: 'runtime:env-1',
      runtimeOwnerEnvironmentId: 'env-1'
    })
  })

  it('passes the active folder workspace as parent for in-app worktree creates', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      instanceId: 'child-instance'
    })
    const workspaceLineage = makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(wt.id),
      childInstanceId: 'child-instance',
      parentWorkspaceKey: folderWorkspaceKey('folder-1'),
      capture: { source: 'active-workspace', confidence: 'explicit' }
    })
    store.setState({
      activeWorkspaceKey: folderWorkspaceKey('folder-1')
    } as Partial<AppState>)
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt, workspaceLineage })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        name: 'feature',
        parentWorkspace: folderWorkspaceKey('folder-1')
      })
    )
    expect(store.getState().workspaceLineageByChildKey).toEqual({
      [workspaceLineage.childWorkspaceKey]: workspaceLineage
    })
  })

  it('merges create result metadata into a worktree inserted by the watcher race', async () => {
    const store = createTestStore()
    const watcherWorktree = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    const createdWorktree = makeWorktree({
      ...watcherWorktree,
      baseRef: 'refs/remotes/origin/main'
    })
    store.setState({
      worktreesByRepo: { repo1: [watcherWorktree] }
    } as Partial<AppState>)
    mockApi.worktrees.create.mockResolvedValue({ worktree: createdWorktree })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(store.getState().worktreesByRepo.repo1).toHaveLength(1)
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      id: watcherWorktree.id,
      baseRef: 'refs/remotes/origin/main'
    })
  })

  it('requests a warning dialog when creation falls back to a local base', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    const baseFallback = {
      requestedRef: 'origin/main',
      localRef: 'main'
    }
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt, baseFallback })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(requestWorktreeBaseFallbackNotice).toHaveBeenCalledWith(baseFallback)
  })

  it.each([
    {
      status: 'skipped_dirty_worktree',
      expectedReason: 'uncommitted changes'
    },
    {
      status: 'skipped_not_fast_forward',
      expectedReason: 'cannot be fast-forwarded cleanly'
    },
    {
      status: 'skipped_error',
      expectedReason: 'Git returned an error'
    }
  ] satisfies {
    status: LocalBaseRefRefreshResult['status']
    expectedReason: string
  }[])('warns when local base ref refresh returns $status', async ({ status, expectedReason }) => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'feature-wt'
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefRefresh: {
        status,
        baseRef: 'origin/main',
        localBranch: 'main',
        ownerWorktreePath: '/repo'
      }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(toast.warning).toHaveBeenCalledWith('Local main was not refreshed for "feature-wt"', {
      id: 'local-base-ref-refresh-failed:repo1::/path/wt1:main',
      description: expect.stringContaining(expectedReason),
      duration: Infinity,
      dismissible: true
    })
    const description = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]?.description
    expect(description).toContain('feature-wt')
    // Create already succeeded — guidance must push manual recovery, not "try again".
    expect(description).toMatch(/manually/i)
    expect(description).not.toContain('try again')
    expect(description).not.toContain('AI tools')
    expect(description).not.toContain('git diff')
    // Owner path is only meaningful for the dirty-owner skip; do not leak it into other reasons.
    if (status === 'skipped_dirty_worktree') {
      expect(description).toContain('/repo')
    } else {
      expect(description).not.toContain('/repo')
    }
  })

  it('falls back to the generic dirty detail when ownerWorktreePath is missing', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'feature-wt'
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefRefresh: {
        status: 'skipped_dirty_worktree',
        baseRef: 'origin/main',
        localBranch: 'main'
      }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    const description = vi.mocked(toast.warning).mock.calls.at(-1)?.[1]?.description
    expect(description).toContain('uncommitted changes')
    expect(description).toContain('where local main is checked out')
    expect(description).not.toContain('The worktree at')
  })

  it('names the toast from branch when displayName is blank', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature',
      displayName: '   '
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefRefresh: {
        status: 'skipped_error',
        baseRef: 'origin/main',
        localBranch: 'main'
      }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(toast.warning).toHaveBeenCalledWith(
      'Local main was not refreshed for "feature"',
      expect.objectContaining({
        id: 'local-base-ref-refresh-failed:repo1::/path/wt1:main'
      })
    )
  })

  it('does not warn when the local base ref refresh succeeds', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefRefresh: {
        status: 'updated',
        baseRef: 'origin/main',
        localBranch: 'main'
      }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('does not warn when local base ref refresh is omitted from the create result', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    expect(toast.warning).not.toHaveBeenCalled()
  })

  it('suggests turning on local main freshness when the create result reports a stale local base', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1'
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefUpdateSuggestion: {
        baseRef: 'origin/main',
        localBranch: 'main',
        behind: 2
      }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    // Button workflow is tested in the toast component; here we just assert the sticky nudge is raised.
    expect(toast.info).toHaveBeenCalledWith(
      'Local main is behind origin/main',
      expect.objectContaining({
        id: 'local-base-ref-update-suggestion:origin/main:main',
        duration: Infinity,
        dismissible: true
      })
    )
  })

  it('persists the dismissal flag when the suggestion toast is closed or swiped', async () => {
    const store = createTestStore()
    store.setState({
      settings: { refreshLocalBaseRefOnWorktreeCreate: false } as AppState['settings'],
      updateSettings: vi.fn().mockResolvedValue(undefined)
    } as Partial<AppState>)
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefUpdateSuggestion: { baseRef: 'origin/main', localBranch: 'main', behind: 2 }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    const options = vi.mocked(toast.info).mock.calls.at(-1)?.[1] as unknown as {
      onDismiss: () => void
    }
    // The close (X)/swipe path persists the decline flag.
    options.onDismiss()
    await Promise.resolve()

    expect(store.getState().updateSettings).toHaveBeenCalledWith({
      localBaseRefSuggestionDismissed: true
    })
  })

  it('does not record a dismissal on close when the feature is already enabled', async () => {
    const store = createTestStore()
    store.setState({
      settings: { refreshLocalBaseRefOnWorktreeCreate: true } as AppState['settings'],
      updateSettings: vi.fn().mockResolvedValue(undefined)
    } as Partial<AppState>)
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      localBaseRefUpdateSuggestion: { baseRef: 'origin/main', localBranch: 'main', behind: 1 }
    })

    await store.getState().createWorktree('repo1', 'feature', 'origin/main')

    const options = vi.mocked(toast.info).mock.calls.at(-1)?.[1] as unknown as {
      onDismiss: () => void
    }
    // Turn On dismisses the toast (firing onDismiss); that must not be recorded as a decline.
    options.onDismiss()
    await Promise.resolve()

    expect(store.getState().updateSettings).not.toHaveBeenCalledWith({
      localBaseRefSuggestionDismissed: true
    })
  })

  it('stamps manualOrder on create while Manual sort is active', async () => {
    const store = createTestStore()
    store.setState({ sortBy: 'manual' } as Partial<AppState>)
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(123_456)
    const wt = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      manualOrder: 123_456
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    try {
      await store.getState().createWorktree('repo1', 'feature')
    } finally {
      nowSpy.mockRestore()
    }

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        manualOrder: 123_456
      })
    )
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      manualOrder: 123_456
    })
  })

  it('passes branchNameOverride through the local create IPC payload', async () => {
    const store = createTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/feature-something',
      repoId: 'repo1',
      path: '/path/feature-something',
      branch: 'feature/something'
    })
    mockApi.worktrees.create.mockResolvedValue({ worktree: wt })

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature/something',
        'origin/main',
        'inherit',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'feature/something'
      )

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        name: 'feature/something',
        baseBranch: 'origin/main',
        branchNameOverride: 'feature/something'
      })
    )
  })

  it('retries a suffixed branchNameOverride when local IPC reports a branch conflict', async () => {
    const store = createTestStore()
    const error = new Error(
      'Branch "feature/something" already exists. Pick a different worktree name.'
    )
    const wt = makeWorktree({
      id: 'repo1::/path/feature-something-2',
      repoId: 'repo1',
      path: '/path/feature-something-2',
      branch: 'feature/something-2'
    })
    mockApi.worktrees.create.mockRejectedValueOnce(error)
    mockApi.worktrees.create.mockResolvedValueOnce({ worktree: wt })

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature/something',
        'origin/main',
        'inherit',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'feature/something'
      )

    expect(mockApi.worktrees.create).toHaveBeenCalledTimes(2)
    expect(mockApi.worktrees.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        name: 'feature/something',
        branchNameOverride: 'feature/something'
      })
    )
    expect(mockApi.worktrees.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        name: 'feature/something-2',
        branchNameOverride: 'feature/something-2'
      })
    )
  })

  it('does not overwrite a newer reconcile status with the initial checking status', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.create.mockImplementation(async () => {
      store.getState().updateWorktreeBaseStatus({
        repoId: 'repo1',
        worktreeId: wt.id,
        status: 'drift',
        base: 'origin/main',
        remote: 'origin',
        behind: 2,
        recentSubjects: ['new base commit']
      })
      return {
        worktree: wt,
        initialBaseStatus: {
          repoId: 'repo1',
          worktreeId: wt.id,
          status: 'checking',
          base: 'origin/main',
          remote: 'origin'
        }
      }
    })

    await store.getState().createWorktree('repo1', 'feature')

    expect(store.getState().baseStatusByWorktreeId[wt.id]).toMatchObject({
      status: 'drift',
      behind: 2
    })
  })
})

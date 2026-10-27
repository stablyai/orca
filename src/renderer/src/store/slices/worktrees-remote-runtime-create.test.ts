import { setLocalRuntimeCapabilitiesForTests } from '../../runtime/local-runtime-capabilities'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  createCompatibleRuntimeStatusResponse,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { TEST_REPO, makeWorktree } from './worktrees-slice-test-fixtures'
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

describe('worktree remote runtime mutations', () => {
  it.each([false, true])(
    'gates existing-branch intent on host capability (%s), retaining legacy suffix retry only without it',
    async (supported) => {
      const status = createCompatibleRuntimeStatusResponse('runtime-remote')
      if (status.ok && !supported) {
        status.result.capabilities = status.result.capabilities?.filter(
          (cap) => cap !== 'worktree.open-existing-branch.v1'
        )
      }
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
        args.method === 'status.get' ? status : runtimeEnvironmentCall(args)
      )
      const store = createRepoTestStore()
      seedRepoHost(store, 'runtime:env-1')
      const create = store.getState().createWorktree
      const args: Parameters<typeof create> = ['repo1', 'feature/test', 'origin/main', 'skip']
      args[12] = 'feature/test'
      args[25] = { branchIntent: 'open-existing' }
      runtimeEnvironmentCall.mockRejectedValueOnce(new Error('Branch already has PR #42'))
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'create',
        ok: true,
        result: {
          worktree: makeWorktree({
            id: 'repo1::/path/feature-test-2',
            repoId: 'repo1',
            path: '/path/feature-test-2'
          })
        }
      })

      await (supported
        ? expect(create(...args)).rejects.toThrow('Branch already has PR #42')
        : create(...args))
      const first = runtimeEnvironmentCall.mock.calls[0][0].params
      if (supported) {
        expect(first).toMatchObject({
          branchIntent: 'open-existing',
          branchNameOverride: 'feature/test'
        })
        expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
      } else {
        expect(first).not.toHaveProperty('branchIntent')
        expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
        expect(runtimeEnvironmentCall.mock.calls[1][0].params).toMatchObject({
          branchNameOverride: 'feature/test-2'
        })
      }
    }
  )

  it('sends picker intent through the capable local host without suffixing a Git failure', async () => {
    setLocalRuntimeCapabilitiesForTests(['worktree.open-existing-branch.v1'])
    try {
      const store = createRepoTestStore()
      const create = store.getState().createWorktree
      const args: Parameters<typeof create> = ['repo1', 'feature/test', 'origin/main', 'skip']
      args[12] = 'feature/test'
      args[25] = { branchIntent: 'open-existing' }
      mockApi.worktrees.create.mockRejectedValueOnce(new Error('Branch already exists locally'))
      await expect(create(...args)).rejects.toThrow('Branch already exists locally')
      expect(mockApi.worktrees.create).toHaveBeenCalledTimes(1)
      expect(mockApi.worktrees.create).toHaveBeenCalledWith(
        expect.objectContaining({
          branchIntent: 'open-existing',
          branchNameOverride: 'feature/test'
        })
      )
    } finally {
      setLocalRuntimeCapabilitiesForTests(null)
    }
  })

  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('creates worktrees through the active remote runtime environment', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/feature',
      repoId: 'repo1',
      path: '/path/feature'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: {
        ...store.getState().settings!,
        activeRuntimeEnvironmentId: 'env-1',
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: true,
        localBaseRefSuggestionDismissed: false
      },
      worktreesByRepo: { repo1: [] }
    })
    seedRepoHost(store, 'runtime:env-1')

    const result = await store
      .getState()
      .createWorktree(
        'repo1',
        'feature',
        'origin/main',
        'skip',
        { directories: ['src'], presetId: 'preset-1' },
        'sidebar',
        'Feature title',
        123,
        456,
        { remoteName: 'fork', branchName: 'feature' }
      )

    expect(result).toEqual({ worktree: wt })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'worktree.create',
      params: {
        repo: 'repo1',
        name: 'feature',
        baseBranch: 'origin/main',
        setupDecision: 'skip',
        sparseCheckout: { directories: ['src'], presetId: 'preset-1' },
        nestWorkspaces: false,
        refreshLocalBaseRefOnWorktreeCreate: true,
        localBaseRefSuggestionDismissed: false,
        telemetrySource: 'sidebar',
        displayName: 'Feature title',
        linkedIssue: 123,
        linkedPR: 456,
        pushTarget: { remoteName: 'fork', branchName: 'feature' }
      },
      timeoutMs: 10 * 60_000
    })
    expect(mockApi.worktrees.create).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1).toEqual([
      {
        ...wt,
        projectId: 'repo:repo1',
        projectHostSetupId: 'repo1',
        hostId: 'runtime:env-1',
        runtimeOwnerEnvironmentId: 'env-1'
      }
    ])
  })

  it('forwards generated-name provenance through paired-runtime create', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/nautilus', repoId: 'repo1' })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)
    seedRepoHost(store, 'runtime:env-1')
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = ['repo1', 'nautilus']
    args[25] = { nameWasGenerated: true }

    await createWorktree(...args)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worktree.create',
        params: expect.objectContaining({ nameWasGenerated: true })
      })
    )
  })

  it('persists Jira item and source context through paired-runtime create', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/jira-link',
      repoId: 'repo1',
      path: '/path/jira-link'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)
    seedRepoHost(store, 'runtime:env-1')
    const linkedWorkItem = {
      provider: 'jira' as const,
      type: 'issue' as const,
      number: 0,
      title: 'ORCA-123 Link Jira',
      url: 'https://company.atlassian.net/browse/ORCA-123',
      jiraIdentifier: 'ORCA-123'
    }
    const linkedTaskSourceContext = {
      kind: 'task-source' as const,
      provider: 'jira' as const,
      projectId: 'project-1',
      hostId: 'runtime:env-1' as const,
      providerIdentity: {
        provider: 'jira' as const,
        siteId: 'site-1',
        siteUrl: 'https://company.atlassian.net',
        projectKey: 'ORCA'
      }
    }
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = ['repo1', 'jira-link']
    args[25] = { linkedWorkItem, linkedTaskSourceContext }

    await createWorktree(...args)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worktree.create',
        params: expect.objectContaining({ linkedWorkItem, linkedTaskSourceContext })
      })
    )
  })

  it('blocks Jira linking when the paired runtime lacks durable metadata capability', async () => {
    const oldRuntimeStatus = createCompatibleRuntimeStatusResponse('runtime-old')
    if (oldRuntimeStatus.ok) {
      oldRuntimeStatus.result.capabilities = oldRuntimeStatus.result.capabilities?.filter(
        (capability) => capability !== 'worktree.linked-work-item-context.v1'
      )
    }
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      args.method === 'status.get' ? oldRuntimeStatus : runtimeEnvironmentCall(args)
    )
    const store = createRepoTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)
    seedRepoHost(store, 'runtime:env-1')
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = ['repo1', 'jira-link']
    args[25] = {
      linkedWorkItem: {
        provider: 'jira',
        type: 'issue',
        number: 0,
        title: 'ORCA-123 Link Jira',
        url: 'https://company.atlassian.net/browse/ORCA-123',
        jiraIdentifier: 'ORCA-123'
      }
    }

    await expect(createWorktree(...args)).rejects.toThrow('Update the remote runtime to link Jira')
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('passes startup commands through remote runtime worktree creation', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/agent-startup',
      repoId: 'repo1',
      path: '/path/agent-startup'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)
    seedRepoHost(store, 'runtime:env-1')

    await store
      .getState()
      .createWorktree(
        'repo1',
        'agent-startup',
        undefined,
        'skip',
        undefined,
        'sidebar',
        'Launch agent',
        undefined,
        undefined,
        undefined,
        'codex',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          command: "codex 'summarize repo'",
          env: { ORCA_AGENT_MODE: 'direct' },
          launchConfig: {
            agentCommand: 'codex',
            agentArgs: '--model gpt-5',
            agentEnv: { ORCA_AGENT_MODE: 'direct' }
          }
        }
      )

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worktree.create',
        params: expect.objectContaining({
          repo: 'repo1',
          name: 'agent-startup',
          setupDecision: 'skip',
          telemetrySource: 'sidebar',
          displayName: 'Launch agent',
          createdWithAgent: 'codex',
          startupCommand: "codex 'summarize repo'",
          startupEnv: { ORCA_AGENT_MODE: 'direct' },
          startupLaunchConfig: {
            agentCommand: 'codex',
            agentArgs: '--model gpt-5',
            agentEnv: { ORCA_AGENT_MODE: 'direct' }
          },
          activate: true
        })
      })
    )
  })

  it('passes task startup drafts only to the owning remote runtime', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/task-draft',
      repoId: 'repo1',
      path: '/path/task-draft'
    })
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)
    seedRepoHost(store, 'runtime:env-1')
    const createWorktree = store.getState().createWorktree
    const args: Parameters<typeof createWorktree> = ['repo1', 'task-draft', undefined, 'inherit']
    args[10] = 'codex'
    args[25] = { startupDraft: 'https://github.com/stablyai/orca/issues/12' }

    await createWorktree(...args)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'worktree.create',
        params: expect.objectContaining({
          createdWithAgent: 'codex',
          startupDraft: 'https://github.com/stablyai/orca/issues/12'
        })
      })
    )
    expect(mockApi.worktrees.create).not.toHaveBeenCalled()
  })

  it('passes startup commands through local worktree creation IPC', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/local-agent-startup',
      repoId: 'repo1',
      path: '/path/local-agent-startup'
    })
    mockApi.worktrees.create.mockResolvedValue({
      worktree: wt,
      startupTerminal: { spawned: true, surface: 'visible' }
    })
    store.setState({
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)

    await store
      .getState()
      .createWorktree(
        'repo1',
        'local-agent-startup',
        undefined,
        'skip',
        undefined,
        'sidebar',
        'Launch local agent',
        undefined,
        undefined,
        undefined,
        'claude',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
          command: "claude --prefill 'summarize repo'",
          env: { ORCA_AGENT_MODE: 'direct' },
          telemetry: {
            agent_kind: 'claude-code',
            launch_source: 'new_workspace_composer',
            request_kind: 'new'
          }
        }
      )

    expect(mockApi.worktrees.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: 'repo1',
        name: 'local-agent-startup',
        setupDecision: 'skip',
        telemetrySource: 'sidebar',
        displayName: 'Launch local agent',
        createdWithAgent: 'claude',
        startup: {
          command: "claude --prefill 'summarize repo'",
          env: { ORCA_AGENT_MODE: 'direct' },
          telemetry: {
            agent_kind: 'claude-code',
            launch_source: 'new_workspace_composer',
            request_kind: 'new'
          }
        }
      })
    )
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('retries a suffixed branchNameOverride when runtime create reports a branch conflict', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({
      id: 'repo1::/path/feature-something-2',
      repoId: 'repo1',
      path: '/path/feature-something-2',
      branch: 'feature/something-2'
    })
    runtimeEnvironmentCall.mockRejectedValueOnce(new Error('Branch already exists on a remote'))
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-create',
      ok: true,
      result: { worktree: wt },
      _meta: { runtimeId: 'runtime-remote' }
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      worktreesByRepo: { repo1: [] }
    } as Partial<AppState>)
    seedRepoHost(store, 'runtime:env-1')

    await store
      .getState()
      .createWorktree(
        'repo1',
        'feature/something',
        'origin/main',
        'skip',
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

    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(2)
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        params: expect.objectContaining({
          name: 'feature/something',
          branchNameOverride: 'feature/something'
        })
      })
    )
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        params: expect.objectContaining({
          name: 'feature/something-2',
          branchNameOverride: 'feature/something-2'
        })
      })
    )
  })
})

// Creation routes by the project row's own host, so every test seeds that row.
function seedRepoHost(store: ReturnType<typeof createTestStore>, hostId: ExecutionHostId): void {
  store.setState({ repos: [{ ...TEST_REPO, executionHostId: hostId }] })
}

function createRepoTestStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedRepoHost(store, 'local')
  return store
}

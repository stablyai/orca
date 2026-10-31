import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import {
  lookupGitHubWorkItemDetailsForSource,
  lookupGitHubWorkItemByOwnerRepoForSource
} from './github-work-item-source-lookup'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import {
  clearRuntimeEnvironmentConnectionGenerations,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status-connection-generation'
import type { GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: vi.fn(),
    runtimeEnvironmentSupportsCapability: vi.fn().mockResolvedValue(false)
  }
})

const runtimeSourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'github',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  repoId: 'runtime-repo'
}

describe('GitHub source lookup routing', () => {
  beforeEach(() => {
    replaceRuntimeEnvironmentRevisions([{ id: 'env-1', createdAt: 100, pairingRevision: 701 }])
    setRuntimeEnvironmentConnectionGenerationForTests('env-1', 4)
    vi.mocked(callRuntimeRpc).mockReset()
    vi.stubGlobal('window', {
      api: {
        gh: {
          workItemDetails: vi.fn(),
          workItemByOwnerRepo: vi.fn().mockResolvedValue(null)
        }
      }
    })
  })

  afterEach(() => {
    replaceRuntimeEnvironmentRevisions([])
    clearRuntimeEnvironmentConnectionGenerations()
    vi.unstubAllGlobals()
  })

  it.each(['local', 'ssh:build-box'] as const)(
    'forwards %s source identity to exact repository IPC',
    async (hostId) => {
      const sourceContext: TaskSourceContext = { ...runtimeSourceContext, hostId, repoId: 'repo' }
      await lookupGitHubWorkItemByOwnerRepoForSource({
        repoPath: '/repo',
        repoId: 'repo',
        sourceContext,
        owner: 'acme',
        repo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      })
      expect(window.api.gh.workItemByOwnerRepo).toHaveBeenCalledWith({
        repoPath: '/repo',
        repoId: 'repo',
        sourceContext,
        owner: 'acme',
        repo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      })
      expect(callRuntimeRpc).not.toHaveBeenCalled()
    }
  )

  it('routes exact repository lookup to its source runtime instead of local IPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)
    await lookupGitHubWorkItemByOwnerRepoForSource({
      repoPath: '/repo',
      repoId: 'renderer-repo',
      sourceContext: runtimeSourceContext,
      owner: 'acme',
      repo: 'orca',
      host: 'github.com',
      number: 42,
      type: 'pr'
    })
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemByOwnerRepo',
      {
        repo: 'runtime-repo',
        owner: 'acme',
        ownerRepo: 'orca',
        host: 'github.com',
        number: 42,
        type: 'pr'
      },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gh.workItemByOwnerRepo).not.toHaveBeenCalled()
  })

  it.each([
    { capable: true, returned: 'matching' },
    { capable: false, returned: 'matching' },
    { capable: false, returned: 'matching-no-runtime' },
    { capable: false, returned: 'upstream' },
    { capable: false, returned: 'wrong-kind' },
    { capable: false, returned: 'null' }
  ])(
    'uses actual authority and validates the full addressed read: %j',
    async ({ capable, returned }) => {
      const ownerRepo = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
      const details: GitHubWorkItemDetails | null =
        returned === 'null'
          ? null
          : {
              item: {
                id: 'issue:42',
                number: 42,
                type: returned === 'wrong-kind' ? 'pr' : 'issue',
                title: 'selected issue',
                url: `https://github.com/${returned === 'upstream' ? 'upstream' : 'fork-owner'}/widgets/${returned === 'wrong-kind' ? 'pull' : 'issues'}/42`,
                labels: [],
                author: null,
                state: 'open',
                updatedAt: ''
              },
              body: 'provider body',
              comments: []
            }
      const runtimeId = capable
        ? 'capable-runtime'
        : returned === 'matching-no-runtime'
          ? undefined
          : 'legacy-runtime'
      vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
        if (method === 'status.get') {
          return {
            ...(runtimeId ? { runtimeId } : {}),
            ...(capable ? { capabilities: ['github.exact-work-item-target.v1'] } : {})
          }
        }
        if (method === 'github.workItemDetails') {
          return details
        }
        throw new Error(`Unexpected runtime method ${method}`)
      })
      const request = lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/runtime/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        number: 42,
        type: 'issue',
        ownerRepo
      })
      await (returned.startsWith('matching')
        ? expect(request).resolves.toEqual(details)
        : expect(request).rejects.toThrow('fork-owner/widgets#42'))
      expect(callRuntimeRpc).toHaveBeenCalledTimes(2)
      expect(callRuntimeRpc).toHaveBeenNthCalledWith(
        1,
        { kind: 'environment', environmentId: 'env-1' },
        'status.get',
        undefined,
        {
          timeoutMs: 15_000,
          expectedEnvironmentPairingRevision: 701,
          beforeSend: expect.any(Function)
        }
      )
      expect(callRuntimeRpc).toHaveBeenNthCalledWith(
        2,
        { kind: 'environment', environmentId: 'env-1' },
        'github.workItemDetails',
        { repo: 'runtime-repo', number: 42, type: 'issue', ...(capable ? { ownerRepo } : {}) },
        {
          timeoutMs: 30_000,
          expectedEnvironmentPairingRevision: 701,
          expectedEnvironmentRuntimeId: runtimeId,
          beforeSend: expect.any(Function)
        }
      )
      expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
    }
  )

  it('uses the renderer repo id for runtime details when the source has no repo id', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(null)

    await lookupGitHubWorkItemDetailsForSource({
      repoPath: '/home/runtime/app',
      repoId: 'renderer-repo',
      sourceContext: { ...runtimeSourceContext, repoId: null },
      number: 42,
      type: 'pr'
    })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'github.workItemDetails',
      { repo: 'renderer-repo', number: 42, type: 'pr' },
      {
        timeoutMs: 30_000,
        expectedEnvironmentPairingRevision: 701,
        expectedEnvironmentRuntimeId: undefined,
        beforeSend: expect.any(Function)
      }
    )
    expect(callRuntimeRpc).toHaveBeenCalledTimes(1)
    expect(window.api.gh.workItemDetails).not.toHaveBeenCalled()
  })

  it('keeps local GitHub details on Electron IPC with source context', async () => {
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)
    const sourceContext: TaskSourceContext = {
      ...runtimeSourceContext,
      hostId: 'local',
      repoId: 'local-repo'
    }

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: 'C:\\workspace\\app',
        repoId: 'local-repo',
        sourceContext,
        number: 42,
        type: 'issue'
      })
    ).resolves.toBeNull()

    expect(window.api.gh.workItemDetails).toHaveBeenCalledWith({
      repoPath: 'C:\\workspace\\app',
      repoId: 'local-repo',
      sourceContext,
      number: 42,
      type: 'issue'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('sends a local issue row repository to the repo-scoped details route', async () => {
    const ownerRepo = { owner: 'fork-owner', repo: 'widgets', host: 'github.com' }
    vi.mocked(window.api.gh.workItemDetails).mockResolvedValue(null)

    await expect(
      lookupGitHubWorkItemDetailsForSource({
        repoPath: '/home/fixture/widgets',
        repoId: 'local-repo',
        number: 12,
        type: 'issue',
        ownerRepo
      })
    ).rejects.toThrow('fork-owner/widgets#12')

    expect(window.api.gh.workItemDetails).toHaveBeenCalledWith(
      expect.objectContaining({ repoPath: '/home/fixture/widgets', ownerRepo })
    )
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})

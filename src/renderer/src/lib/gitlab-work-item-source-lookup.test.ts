import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import {
  listGitLabWorkItemsForSource,
  lookupGitLabWorkItemByPathForSource
} from './gitlab-work-item-source-lookup'
import type { GitLabPagedResult, GitLabWorkItem } from '../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return {
    ...actual,
    callRuntimeRpc: vi.fn()
  }
})

function gitlabItem(overrides: Partial<GitLabWorkItem> = {}): GitLabWorkItem {
  return {
    id: 'gitlab-mr-7',
    type: 'mr',
    number: 7,
    title: 'Runtime MR',
    state: 'opened',
    url: 'https://gitlab.com/acme/app/-/merge_requests/7',
    labels: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    author: null,
    repoId: 'runtime-repo',
    ...overrides
  }
}

const runtimeSourceContext: TaskSourceContext = {
  kind: 'task-source',
  provider: 'gitlab',
  projectId: 'project-1',
  hostId: 'runtime:env-1',
  repoId: 'runtime-repo'
}

describe('GitLab source lookup routing', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset()
    vi.stubGlobal('window', {
      api: {
        gl: {
          workItemByPath: vi.fn(),
          listWorkItems: vi.fn()
        }
      }
    })
  })

  it('routes runtime-owned GitLab URL lookup through runtime RPC', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(gitlabItem({ repoId: 'runtime-returned' }))

    await expect(
      lookupGitLabWorkItemByPathForSource({
        repoPath: '/workspace/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        host: 'gitlab.com',
        path: 'acme/app',
        iid: 7,
        type: 'mr'
      })
    ).resolves.toMatchObject({ repoId: 'renderer-repo', number: 7 })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitlab.workItemByPath',
      expect.objectContaining({
        repo: 'id:runtime-repo',
        host: 'gitlab.com',
        path: 'acme/app',
        iid: 7,
        type: 'mr'
      }),
      { timeoutMs: 30_000 }
    )
    expect(window.api.gl.workItemByPath).not.toHaveBeenCalled()
  })

  it('routes runtime-owned GitLab work item lists through runtime RPC', async () => {
    const result: GitLabPagedResult<GitLabWorkItem> = {
      items: [gitlabItem({ repoId: 'runtime-returned' })],
      page: 3,
      perPage: 1,
      totalCount: 0,
      totalPages: 4
    }
    vi.mocked(callRuntimeRpc).mockResolvedValue(result)

    await expect(
      listGitLabWorkItemsForSource({
        repoPath: '/workspace/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        state: 'opened',
        page: 3,
        perPage: 1,
        query: 'fix login'
      })
    ).resolves.toEqual({ ...result, items: [gitlabItem({ repoId: 'renderer-repo' })] })

    // Forward the query through runtime RPC or GitLab search would return unfiltered results (#6263).
    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitlab.listWorkItems',
      expect.objectContaining({
        repo: 'id:runtime-repo',
        state: 'opened',
        page: 3,
        perPage: 1,
        query: 'fix login'
      }),
      { timeoutMs: 30_000 }
    )
    expect(window.api.gl.listWorkItems).not.toHaveBeenCalled()
  })

  it('forwards the search query to local GitLab work item lists over Electron IPC', async () => {
    const localSourceContext: TaskSourceContext = {
      ...runtimeSourceContext,
      hostId: 'local',
      repoId: 'local-repo'
    }
    const result = {
      items: [gitlabItem({ repoId: 'local-returned' })],
      page: 3,
      perPage: 1,
      totalCount: 0,
      totalPages: 4
    }
    vi.mocked(window.api.gl.listWorkItems).mockResolvedValue(result)

    await expect(
      listGitLabWorkItemsForSource({
        repoPath: '/workspace/app',
        repoId: 'local-repo',
        sourceContext: localSourceContext,
        state: 'opened',
        page: 3,
        perPage: 1,
        query: 'fix login'
      })
    ).resolves.toEqual({ ...result, items: [gitlabItem({ repoId: 'local-repo' })] })

    expect(window.api.gl.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/workspace/app',
      repoId: 'local-repo',
      sourceContext: localSourceContext,
      state: 'opened',
      page: 3,
      perPage: 1,
      query: 'fix login'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('keeps local GitLab lookups on Electron IPC with source context', async () => {
    vi.mocked(window.api.gl.workItemByPath).mockResolvedValue(
      gitlabItem({ repoId: 'local-returned' })
    )

    await expect(
      lookupGitLabWorkItemByPathForSource({
        repoPath: '/workspace/app',
        repoId: 'local-repo',
        sourceContext: { ...runtimeSourceContext, hostId: 'local', repoId: 'local-repo' },
        host: 'gitlab.com',
        path: 'acme/app',
        iid: 7,
        type: 'mr'
      })
    ).resolves.toMatchObject({ repoId: 'local-repo', number: 7 })

    expect(window.api.gl.workItemByPath).toHaveBeenCalledWith({
      repoPath: '/workspace/app',
      repoId: 'local-repo',
      sourceContext: { ...runtimeSourceContext, hostId: 'local', repoId: 'local-repo' },
      host: 'gitlab.com',
      path: 'acme/app',
      iid: 7,
      type: 'mr'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })
})

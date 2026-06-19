import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import {
  listGitLabMRsForSource,
  lookupGitLabWorkItemByPathForSource
} from './gitlab-work-item-source-lookup'
import type { GitLabWorkItem, ListMergeRequestsResult } from '../../../shared/types'
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
          listMRs: vi.fn()
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
      { repo: 'runtime-repo', host: 'gitlab.com', path: 'acme/app', iid: 7, type: 'mr' },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gl.workItemByPath).not.toHaveBeenCalled()
  })

  it('routes runtime-owned GitLab MR lists through runtime RPC', async () => {
    const result: ListMergeRequestsResult = {
      items: [gitlabItem({ repoId: 'runtime-returned' })],
      page: 1,
      perPage: 12,
      totalCount: 1,
      totalPages: 1
    }
    vi.mocked(callRuntimeRpc).mockResolvedValue(result)

    await expect(
      listGitLabMRsForSource({
        repoPath: '/workspace/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        state: 'opened',
        page: 1,
        perPage: 12
      })
    ).resolves.toMatchObject({ items: [{ repoId: 'renderer-repo', number: 7 }] })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitlab.listMRs',
      { repo: 'runtime-repo', state: 'opened', page: 1, perPage: 12 },
      { timeoutMs: 30_000 }
    )
    expect(window.api.gl.listMRs).not.toHaveBeenCalled()
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

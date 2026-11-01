import { beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import type * as RuntimeRpcClient from '@/runtime/runtime-rpc-client'
import {
  listGiteaWorkItemsForSource,
  lookupGiteaProjectSlugForSource,
  lookupGiteaWorkItemByPathForSource,
  resolveGiteaWorkItemsForQuery
} from './gitea-work-item-source-lookup'
import type { GiteaWorkItem, ListGiteaPullRequestsResult } from '../../../shared/gitea-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'

vi.mock('@/runtime/runtime-rpc-client', async () => {
  const actual = await vi.importActual<typeof RuntimeRpcClient>('@/runtime/runtime-rpc-client')
  return { ...actual, callRuntimeRpc: vi.fn() }
})

function giteaItem(overrides: Partial<GiteaWorkItem> = {}): GiteaWorkItem {
  return {
    id: 'gitea-pr-7',
    type: 'pr',
    number: 7,
    title: 'Runtime PR',
    state: 'open',
    url: 'https://gitea.example.com/acme/app/pulls/7',
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

describe('Gitea source lookup routing', () => {
  beforeEach(() => {
    vi.mocked(callRuntimeRpc).mockReset()
    vi.stubGlobal('window', {
      api: {
        gitea: {
          workItemByPath: vi.fn(),
          listWorkItems: vi.fn(),
          projectSlug: vi.fn()
        }
      }
    })
  })

  it('routes runtime-owned URL lookup through runtime RPC and stamps the renderer repo id', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue(giteaItem({ repoId: 'runtime-returned' }))

    await expect(
      lookupGiteaWorkItemByPathForSource({
        repoPath: '/workspace/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext,
        host: 'gitea.example.com',
        path: 'acme/app',
        number: 7,
        type: 'pr'
      })
    ).resolves.toMatchObject({ repoId: 'renderer-repo', number: 7 })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitea.workItemByPath',
      expect.objectContaining({
        repo: 'id:runtime-repo',
        host: 'gitea.example.com',
        path: 'acme/app',
        number: 7,
        type: 'pr'
      }),
      { timeoutMs: 30_000 }
    )
    expect(window.api.gitea.workItemByPath).not.toHaveBeenCalled()
  })

  it('returns null when the item does not exist', async () => {
    vi.mocked(window.api.gitea.workItemByPath).mockResolvedValue(null)

    await expect(
      lookupGiteaWorkItemByPathForSource({
        repoPath: '/workspace/app',
        repoId: 'local-repo',
        host: 'gitea.example.com',
        path: 'acme/app',
        number: 9,
        type: 'issue'
      })
    ).resolves.toBeNull()
  })

  it('forwards the search query to local work item lists over Electron IPC', async () => {
    const result: ListGiteaPullRequestsResult = {
      items: [giteaItem({ repoId: 'local-returned' })],
      page: 2,
      perPage: 1,
      totalCount: 0,
      totalPages: 3
    }
    vi.mocked(window.api.gitea.listWorkItems).mockResolvedValue(result)

    await expect(
      listGiteaWorkItemsForSource({
        repoPath: '/workspace/app',
        repoId: 'local-repo',
        state: 'opened',
        page: 2,
        perPage: 1,
        query: 'fix login'
      })
    ).resolves.toEqual({ ...result, items: [giteaItem({ repoId: 'local-repo' })] })

    expect(window.api.gitea.listWorkItems).toHaveBeenCalledWith({
      repoPath: '/workspace/app',
      repoId: 'local-repo',
      state: 'opened',
      page: 2,
      perPage: 1,
      query: 'fix login'
    })
    expect(callRuntimeRpc).not.toHaveBeenCalled()
  })

  it('resolves the project slug through the owning host', async () => {
    vi.mocked(callRuntimeRpc).mockResolvedValue({ host: 'gitea.example.com', path: 'acme/app' })

    await expect(
      lookupGiteaProjectSlugForSource({
        repoPath: '/workspace/app',
        repoId: 'renderer-repo',
        sourceContext: runtimeSourceContext
      })
    ).resolves.toEqual({ host: 'gitea.example.com', path: 'acme/app' })

    expect(callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'gitea.projectSlug',
      expect.objectContaining({ repo: 'id:runtime-repo' }),
      { timeoutMs: 30_000 }
    )
  })

  describe('resolveGiteaWorkItemsForQuery', () => {
    const base = { repoPath: '/workspace/app', repoId: 'local-repo' }

    it('looks up #N as both an issue and a PR on the repo project', async () => {
      vi.mocked(window.api.gitea.projectSlug).mockResolvedValue({
        host: 'gitea.example.com',
        path: 'acme/app'
      })
      vi.mocked(window.api.gitea.workItemByPath).mockImplementation(async (args) =>
        args.type === 'pr' ? giteaItem({ number: args.number }) : null
      )

      const items = await resolveGiteaWorkItemsForQuery({ ...base, query: '#7' })

      expect(items).toEqual([giteaItem({ repoId: 'local-repo' })])
      expect(window.api.gitea.workItemByPath).toHaveBeenCalledTimes(2)
      expect(window.api.gitea.listWorkItems).not.toHaveBeenCalled()
    })

    it('looks up !N as a PR only', async () => {
      vi.mocked(window.api.gitea.projectSlug).mockResolvedValue({
        host: 'gitea.example.com',
        path: 'acme/app'
      })
      vi.mocked(window.api.gitea.workItemByPath).mockResolvedValue(giteaItem())

      await resolveGiteaWorkItemsForQuery({ ...base, query: '!7' })

      expect(window.api.gitea.workItemByPath).toHaveBeenCalledTimes(1)
      expect(window.api.gitea.workItemByPath).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'pr', number: 7, path: 'acme/app' })
      )
    })

    it('uses the owner/repo of owner/repo#N and the host of the project', async () => {
      vi.mocked(window.api.gitea.projectSlug).mockResolvedValue({
        host: 'gitea.example.com',
        path: 'acme/app'
      })
      vi.mocked(window.api.gitea.workItemByPath).mockResolvedValue(null)

      await resolveGiteaWorkItemsForQuery({ ...base, query: 'other/lib#3' })

      expect(window.api.gitea.workItemByPath).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'gitea.example.com', path: 'other/lib', number: 3 })
      )
    })

    it('resolves a pasted pulls URL without asking for the project slug', async () => {
      vi.mocked(window.api.gitea.workItemByPath).mockResolvedValue(giteaItem())

      const items = await resolveGiteaWorkItemsForQuery({
        ...base,
        query: 'https://git.example.com/acme/app/pulls/7'
      })

      expect(items).toHaveLength(1)
      expect(window.api.gitea.projectSlug).not.toHaveBeenCalled()
      expect(window.api.gitea.workItemByPath).toHaveBeenCalledWith(
        expect.objectContaining({ host: 'git.example.com', type: 'pr', number: 7 })
      )
    })

    it('falls back to work-item search for free text', async () => {
      vi.mocked(window.api.gitea.listWorkItems).mockResolvedValue({
        items: [giteaItem()],
        page: 1,
        perPage: 12,
        totalCount: 1,
        totalPages: 1
      })

      const items = await resolveGiteaWorkItemsForQuery({
        ...base,
        query: 'fix login',
        perPage: 12
      })

      expect(items).toHaveLength(1)
      expect(window.api.gitea.listWorkItems).toHaveBeenCalledWith(
        expect.objectContaining({ query: 'fix login', perPage: 12 })
      )
      expect(window.api.gitea.workItemByPath).not.toHaveBeenCalled()
    })

    it('returns nothing when the repo has no Gitea project', async () => {
      vi.mocked(window.api.gitea.projectSlug).mockResolvedValue(null)

      await expect(resolveGiteaWorkItemsForQuery({ ...base, query: '#7' })).resolves.toEqual([])
    })
  })
})

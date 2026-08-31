import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web GitLab preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
    vi.doUnmock('electron')
  })

  it('keeps the web GitLab preload key set in parity with desktop preload', async () => {
    vi.doMock('electron', () => ({
      ipcRenderer: { invoke: vi.fn() }
    }))
    const globals = installBrowserGlobals('Linux')
    const { glApi } = (await import(
      new URL('../../../preload/gitlab.ts', import.meta.url).href
    )) as {
      glApi: Record<string, unknown>
    }
    const { installWebPreloadApi } = await import('./web-preload-api')

    installWebPreloadApi()

    expect(Object.keys(globals.window.api.gl).sort()).toEqual(Object.keys(glApi).sort())
  })

  it('routes every runtime-backed GitLab method through the expected RPC method', async () => {
    type GitLabApi = NonNullable<PreloadApi['gl']>
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { ok: true, items: [] },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    const { GITLAB_WEB_RPC_METHODS } = await import('./preload-api/web-gitlab-routes')
    installWebPreloadApi()
    const api = globals.window.api
    const repoPath = '/workspace/repo'

    const routeCases: {
      key: keyof typeof GITLAB_WEB_RPC_METHODS
      invoke: (gl: GitLabApi) => Promise<unknown>
      expectedMethod: string
      expectedParams: unknown
    }[] = [
      {
        key: 'diagnoseAuth',
        invoke: (gl) => gl.diagnoseAuth(),
        expectedMethod: 'gitlab.diagnoseAuth',
        expectedParams: undefined
      },
      {
        key: 'rateLimit',
        invoke: (gl) => gl.rateLimit({ force: true, host: 'gitlab.example.com' }),
        expectedMethod: 'gitlab.rateLimit',
        expectedParams: { force: true, host: 'gitlab.example.com' }
      },
      {
        key: 'listMRs',
        invoke: (gl) => gl.listMRs({ repoPath, state: 'opened', page: 1, perPage: 50 }),
        expectedMethod: 'gitlab.listMRs',
        expectedParams: { repoPath, repo: repoPath, state: 'opened', page: 1, perPage: 50 }
      },
      {
        key: 'listWorkItems',
        invoke: (gl) => gl.listWorkItems({ repoPath, state: 'closed', page: 2, perPage: 25 }),
        expectedMethod: 'gitlab.listWorkItems',
        expectedParams: { repoPath, repo: repoPath, state: 'closed', page: 2, perPage: 25 }
      },
      {
        key: 'listIssues',
        invoke: (gl) => gl.listIssues({ repoPath, state: 'all', assignee: '@me', limit: 30 }),
        expectedMethod: 'gitlab.listIssues',
        expectedParams: { repoPath, repo: repoPath, state: 'all', assignee: '@me', limit: 30 }
      },
      {
        key: 'createIssue',
        invoke: (gl) => gl.createIssue({ repoPath, title: 'Bug', body: 'Details' }),
        expectedMethod: 'gitlab.createIssue',
        expectedParams: { repoPath, repo: repoPath, title: 'Bug', body: 'Details' }
      },
      {
        key: 'updateIssue',
        invoke: (gl) => gl.updateIssue({ repoPath, number: 7, updates: { state: 'closed' } }),
        expectedMethod: 'gitlab.updateIssue',
        expectedParams: { repoPath, repo: repoPath, number: 7, updates: { state: 'closed' } }
      },
      {
        key: 'addIssueComment',
        invoke: (gl) => gl.addIssueComment({ repoPath, number: 7, body: 'Fixed' }),
        expectedMethod: 'gitlab.addIssueComment',
        expectedParams: { repoPath, repo: repoPath, number: 7, body: 'Fixed' }
      },
      {
        key: 'listLabels',
        invoke: (gl) => gl.listLabels({ repoPath }),
        expectedMethod: 'gitlab.listLabels',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'todos',
        invoke: (gl) => gl.todos({ repoPath }),
        expectedMethod: 'gitlab.todos',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'workItemDetails',
        invoke: (gl) => gl.workItemDetails({ repoPath, iid: 8, type: 'mr' }),
        expectedMethod: 'gitlab.workItemDetails',
        expectedParams: { repoPath, repo: repoPath, iid: 8, type: 'mr' }
      },
      {
        key: 'closeMR',
        invoke: (gl) => gl.closeMR({ repoPath, iid: 8 }),
        expectedMethod: 'gitlab.updateMRState',
        expectedParams: { repoPath, repo: repoPath, iid: 8, state: 'closed' }
      },
      {
        key: 'reopenMR',
        invoke: (gl) => gl.reopenMR({ repoPath, iid: 8 }),
        expectedMethod: 'gitlab.updateMRState',
        expectedParams: { repoPath, repo: repoPath, iid: 8, state: 'opened' }
      },
      {
        key: 'mergeMR',
        invoke: (gl) => gl.mergeMR({ repoPath, iid: 8, method: 'squash' }),
        expectedMethod: 'gitlab.mergeMR',
        expectedParams: { repoPath, repo: repoPath, iid: 8, method: 'squash' }
      },
      {
        key: 'updateMR',
        invoke: (gl) => gl.updateMR({ repoPath, iid: 8, updates: { title: 'New title' } }),
        expectedMethod: 'gitlab.updateMR',
        expectedParams: { repoPath, repo: repoPath, iid: 8, updates: { title: 'New title' } }
      },
      {
        key: 'updateMRReviewers',
        invoke: (gl) => gl.updateMRReviewers({ repoPath, iid: 8, reviewerIds: [1, 2] }),
        expectedMethod: 'gitlab.updateMRReviewers',
        expectedParams: { repoPath, repo: repoPath, iid: 8, reviewerIds: [1, 2] }
      },
      {
        key: 'addMRComment',
        invoke: (gl) => gl.addMRComment({ repoPath, iid: 8, body: 'Ship it' }),
        expectedMethod: 'gitlab.addMRComment',
        expectedParams: { repoPath, repo: repoPath, iid: 8, body: 'Ship it' }
      },
      {
        key: 'addMRInlineComment',
        invoke: (gl) =>
          gl.addMRInlineComment({
            repoPath,
            iid: 8,
            input: {
              body: 'Please fix',
              path: 'src/app.ts',
              line: 12,
              baseSha: 'base',
              startSha: 'start',
              headSha: 'head'
            }
          }),
        expectedMethod: 'gitlab.addMRInlineComment',
        expectedParams: {
          repoPath,
          repo: repoPath,
          iid: 8,
          input: {
            body: 'Please fix',
            path: 'src/app.ts',
            line: 12,
            baseSha: 'base',
            startSha: 'start',
            headSha: 'head'
          }
        }
      },
      {
        key: 'resolveMRDiscussion',
        invoke: (gl) =>
          gl.resolveMRDiscussion({
            repoPath,
            iid: 8,
            discussionId: 'discussion-1',
            resolved: true
          }),
        expectedMethod: 'gitlab.resolveMRDiscussion',
        expectedParams: {
          repoPath,
          repo: repoPath,
          iid: 8,
          discussionId: 'discussion-1',
          resolved: true
        }
      },
      {
        key: 'jobTrace',
        invoke: (gl) => gl.jobTrace({ repoPath, jobId: 99 }),
        expectedMethod: 'gitlab.jobTrace',
        expectedParams: { repoPath, repo: repoPath, jobId: 99 }
      },
      {
        key: 'retryJob',
        invoke: (gl) => gl.retryJob({ repoPath, jobId: 99 }),
        expectedMethod: 'gitlab.retryJob',
        expectedParams: { repoPath, repo: repoPath, jobId: 99 }
      },
      {
        key: 'workItemByPath',
        invoke: (gl) =>
          gl.workItemByPath({
            repoPath,
            host: 'gitlab.example.com',
            path: 'group/project',
            iid: 7,
            type: 'issue'
          }),
        expectedMethod: 'gitlab.workItemByPath',
        expectedParams: {
          repoPath,
          repo: repoPath,
          host: 'gitlab.example.com',
          path: 'group/project',
          iid: 7,
          type: 'issue'
        }
      }
    ]

    expect(routeCases.map((routeCase) => routeCase.key).sort()).toEqual(
      Object.keys(GITLAB_WEB_RPC_METHODS).sort()
    )

    for (const routeCase of routeCases) {
      await routeCase.invoke(api.gl)
    }

    expect(runtimeCalls).toEqual(
      routeCases.map((routeCase) => ({
        method: routeCase.expectedMethod,
        params: routeCase.expectedParams
      }))
    )
  })

  it('routes GitLab repo selectors through repo id when provided', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: method === 'gitlab.workItemDetails' ? null : { ok: true, items: [] },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'gitlab',
      projectId: 'gitlab:gitlab.example.com/group/project',
      hostId: 'runtime:web-env-1',
      repoId: 'repo-gitlab-runtime',
      providerIdentity: {
        provider: 'gitlab',
        projectId: '42',
        namespace: 'group',
        project: 'project',
        webUrl: 'https://gitlab.example.com/group/project'
      }
    }

    await api.gl.listIssues({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitlab-runtime',
      sourceContext,
      state: 'opened'
    })
    await api.gl.updateMR({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitlab-runtime',
      sourceContext,
      iid: 9,
      updates: { title: 'New title' }
    })
    await api.gl.workItemDetails({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitlab-runtime',
      sourceContext,
      iid: 9,
      type: 'mr'
    })

    expect(runtimeCalls).toEqual([
      {
        method: 'gitlab.listIssues',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitlab-runtime',
          sourceContext,
          repo: 'id:repo-gitlab-runtime',
          state: 'opened'
        }
      },
      {
        method: 'gitlab.updateMR',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitlab-runtime',
          sourceContext,
          repo: 'id:repo-gitlab-runtime',
          iid: 9,
          updates: { title: 'New title' }
        }
      },
      {
        method: 'gitlab.workItemDetails',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitlab-runtime',
          sourceContext,
          repo: 'id:repo-gitlab-runtime',
          iid: 9,
          type: 'mr'
        }
      }
    ])
  })

  it('does not send the ready semantic field to an older paired host', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: method === 'status.get' ? { capabilities: [] } : { ok: true },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const result = await globals.window.api.gl.updateMR({
      repoPath: '/workspace/repo',
      iid: 8,
      updates: { readyForReview: true }
    })

    expect(result).toMatchObject({ ok: false })
    expect(runtimeCalls).toEqual([{ method: 'status.get', params: undefined }])
  })

  it('exposes the GitLab task methods used by the shared Tasks page', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'gitlab.listMRs') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: {
                items: [{ id: 'mr-1', type: 'mr', number: 1 }]
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'gitlab.listIssues') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: {
                items: [{ id: 'issue-2', type: 'issue', number: 2 }]
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'gitlab.workItemByPath') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { id: 'issue-7', type: 'issue', number: 7 },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { ok: true },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api

    const mergeRequests = await api.gl.listMRs({
      repoPath: '/workspace/repo',
      state: 'opened',
      page: 1,
      perPage: 50
    })
    const issues = await api.gl.listIssues({
      repoPath: '/workspace/repo',
      state: 'opened',
      assignee: '@me',
      limit: 50
    })
    const item = await api.gl.workItemByPath({
      repoPath: '/workspace/repo',
      host: 'gitlab.example.com',
      path: 'group/project',
      iid: 7,
      type: 'issue'
    })
    await api.gl.closeMR({ repoPath: '/workspace/repo', iid: 7 })

    expect(mergeRequests.items).toEqual([{ id: 'mr-1', type: 'mr', number: 1 }])
    expect(issues.items).toEqual([{ id: 'issue-2', type: 'issue', number: 2 }])
    expect(item).toEqual({ id: 'issue-7', type: 'issue', number: 7 })
    expect(runtimeCalls.map((call) => call.method)).not.toContain('gitlab.listWorkItems')
    expect(runtimeCalls).toEqual([
      {
        method: 'gitlab.listMRs',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          state: 'opened',
          page: 1,
          perPage: 50
        }
      },
      {
        method: 'gitlab.listIssues',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          state: 'opened',
          assignee: '@me',
          limit: 50
        }
      },
      {
        method: 'gitlab.workItemByPath',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          host: 'gitlab.example.com',
          path: 'group/project',
          iid: 7,
          type: 'issue'
        }
      },
      {
        method: 'gitlab.updateMRState',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          iid: 7,
          state: 'closed'
        }
      }
    ])
  })
})

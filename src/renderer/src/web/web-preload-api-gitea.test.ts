import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web Gitea preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('routes every runtime-backed Gitea method through the expected RPC method', async () => {
    type GiteaApi = NonNullable<PreloadApi['gitea']>
    const pagedResult = {
      items: [{ id: 'pr-9', type: 'pr', number: 9 }],
      page: 2,
      perPage: 20,
      totalCount: 1,
      totalPages: 1
    }
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result:
              method === 'gitea.listPRs' || method === 'gitea.listWorkItems'
                ? pagedResult
                : { ok: true },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    const { GITEA_WEB_RPC_METHODS } = await import('./preload-api/web-gitea-routes')
    installWebPreloadApi()
    const api = globals.window.api
    const repoPath = '/workspace/repo'

    const routeCases: {
      key: keyof typeof GITEA_WEB_RPC_METHODS
      invoke: (gitea: GiteaApi) => Promise<unknown>
      expectedMethod: string
      expectedParams: unknown
    }[] = [
      {
        key: 'viewer',
        invoke: (gitea) => gitea.viewer(),
        expectedMethod: 'gitea.viewer',
        expectedParams: undefined
      },
      {
        key: 'diagnoseAuth',
        invoke: (gitea) => gitea.diagnoseAuth(),
        expectedMethod: 'gitea.diagnoseAuth',
        expectedParams: undefined
      },
      {
        key: 'rateLimit',
        invoke: (gitea) => gitea.rateLimit({ force: true, host: 'gitea.example.com' }),
        expectedMethod: 'gitea.rateLimit',
        expectedParams: { force: true, host: 'gitea.example.com' }
      },
      {
        key: 'projectSlug',
        invoke: (gitea) => gitea.projectSlug({ repoPath }),
        expectedMethod: 'gitea.projectSlug',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'prForBranch',
        invoke: (gitea) => gitea.prForBranch({ repoPath, branch: 'feature', linkedPRNumber: 9 }),
        expectedMethod: 'gitea.prForBranch',
        expectedParams: { repoPath, repo: repoPath, branch: 'feature', linkedPRNumber: 9 }
      },
      {
        key: 'pr',
        invoke: (gitea) => gitea.pr({ repoPath, number: 9 }),
        expectedMethod: 'gitea.pr',
        expectedParams: { repoPath, repo: repoPath, number: 9 }
      },
      {
        key: 'listPRs',
        invoke: (gitea) => gitea.listPRs({ repoPath, state: 'opened', page: 2, perPage: 20 }),
        expectedMethod: 'gitea.listPRs',
        expectedParams: { repoPath, repo: repoPath, state: 'opened', page: 2, perPage: 20 }
      },
      {
        key: 'listWorkItems',
        invoke: (gitea) => gitea.listWorkItems({ repoPath, state: 'closed', query: 'bug' }),
        expectedMethod: 'gitea.listWorkItems',
        expectedParams: { repoPath, repo: repoPath, state: 'closed', query: 'bug' }
      },
      {
        key: 'issue',
        invoke: (gitea) => gitea.issue({ repoPath, number: 4 }),
        expectedMethod: 'gitea.issue',
        expectedParams: { repoPath, repo: repoPath, number: 4 }
      },
      {
        key: 'listIssues',
        invoke: (gitea) => gitea.listIssues({ repoPath, state: 'all', assignee: 'ada', limit: 10 }),
        expectedMethod: 'gitea.listIssues',
        expectedParams: { repoPath, repo: repoPath, state: 'all', assignee: 'ada', limit: 10 }
      },
      {
        key: 'createIssue',
        invoke: (gitea) => gitea.createIssue({ repoPath, title: 'Bug', body: 'Details' }),
        expectedMethod: 'gitea.createIssue',
        expectedParams: { repoPath, repo: repoPath, title: 'Bug', body: 'Details' }
      },
      {
        key: 'updateIssue',
        invoke: (gitea) => gitea.updateIssue({ repoPath, number: 4, updates: { state: 'closed' } }),
        expectedMethod: 'gitea.updateIssue',
        expectedParams: { repoPath, repo: repoPath, number: 4, updates: { state: 'closed' } }
      },
      {
        key: 'addIssueComment',
        invoke: (gitea) => gitea.addIssueComment({ repoPath, number: 4, body: 'Fixed' }),
        expectedMethod: 'gitea.addIssueComment',
        expectedParams: { repoPath, repo: repoPath, number: 4, body: 'Fixed' }
      },
      {
        key: 'listLabels',
        invoke: (gitea) => gitea.listLabels({ repoPath }),
        expectedMethod: 'gitea.listLabels',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'listAssignableUsers',
        invoke: (gitea) => gitea.listAssignableUsers({ repoPath }),
        expectedMethod: 'gitea.listAssignableUsers',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'notifications',
        invoke: (gitea) => gitea.notifications({ repoPath }),
        expectedMethod: 'gitea.notifications',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'markNotificationRead',
        invoke: (gitea) => gitea.markNotificationRead({ repoPath, notificationId: 7 }),
        expectedMethod: 'gitea.markNotificationRead',
        expectedParams: { repoPath, repo: repoPath, notificationId: 7 }
      },
      {
        key: 'workItemDetails',
        invoke: (gitea) =>
          gitea.workItemDetails({
            repoPath,
            number: 9,
            type: 'pr',
            includeReviewDetails: true,
            repoOwnerExecutionHostId: 'local',
            background: true
          }),
        expectedMethod: 'gitea.workItemDetails',
        expectedParams: {
          repoPath,
          repo: repoPath,
          number: 9,
          type: 'pr',
          includeReviewDetails: true
        }
      },
      {
        key: 'closePR',
        invoke: (gitea) => gitea.closePR({ repoPath, number: 9 }),
        expectedMethod: 'gitea.updatePRState',
        expectedParams: { repoPath, repo: repoPath, number: 9, state: 'closed' }
      },
      {
        key: 'reopenPR',
        invoke: (gitea) => gitea.reopenPR({ repoPath, number: 9 }),
        expectedMethod: 'gitea.updatePRState',
        expectedParams: { repoPath, repo: repoPath, number: 9, state: 'open' }
      },
      {
        key: 'mergePR',
        invoke: (gitea) => gitea.mergePR({ repoPath, number: 9, method: 'squash' }),
        expectedMethod: 'gitea.mergePR',
        expectedParams: { repoPath, repo: repoPath, number: 9, method: 'squash' }
      },
      {
        key: 'updatePR',
        invoke: (gitea) => gitea.updatePR({ repoPath, number: 9, updates: { draft: false } }),
        expectedMethod: 'gitea.updatePR',
        expectedParams: { repoPath, repo: repoPath, number: 9, updates: { draft: false } }
      },
      {
        key: 'updatePRReviewers',
        invoke: (gitea) =>
          gitea.updatePRReviewers({ repoPath, number: 9, reviewerUsernames: ['ada'] }),
        expectedMethod: 'gitea.updatePRReviewers',
        expectedParams: { repoPath, repo: repoPath, number: 9, reviewerUsernames: ['ada'] }
      },
      {
        key: 'addPRComment',
        invoke: (gitea) => gitea.addPRComment({ repoPath, number: 9, body: 'LGTM' }),
        expectedMethod: 'gitea.addPRComment',
        expectedParams: { repoPath, repo: repoPath, number: 9, body: 'LGTM' }
      },
      {
        key: 'addPRInlineComment',
        invoke: (gitea) =>
          gitea.addPRInlineComment({
            repoPath,
            number: 9,
            input: { body: 'nit', path: 'a.ts', line: 3, headSha: 'abc' }
          }),
        expectedMethod: 'gitea.addPRInlineComment',
        expectedParams: {
          repoPath,
          repo: repoPath,
          number: 9,
          input: { body: 'nit', path: 'a.ts', line: 3, headSha: 'abc' }
        }
      },
      {
        key: 'resolvePRDiscussion',
        invoke: (gitea) =>
          gitea.resolvePRDiscussion({ repoPath, number: 9, discussionId: '15', resolved: true }),
        expectedMethod: 'gitea.resolvePRDiscussion',
        expectedParams: { repoPath, repo: repoPath, number: 9, discussionId: '15', resolved: true }
      },
      {
        key: 'submitPRReview',
        invoke: (gitea) =>
          gitea.submitPRReview({ repoPath, number: 9, decision: 'approve', body: 'ship' }),
        expectedMethod: 'gitea.submitPRReview',
        expectedParams: { repoPath, repo: repoPath, number: 9, decision: 'approve', body: 'ship' }
      },
      {
        key: 'jobTrace',
        invoke: (gitea) => gitea.jobTrace({ repoPath, jobId: 4, logExcerpt: true }),
        expectedMethod: 'gitea.jobTrace',
        expectedParams: { repoPath, repo: repoPath, jobId: 4, logExcerpt: true }
      },
      {
        key: 'workItemByPath',
        invoke: (gitea) =>
          gitea.workItemByPath({
            repoPath,
            host: 'gitea.example.com',
            path: 'team/repo',
            number: 9,
            type: 'issue'
          }),
        expectedMethod: 'gitea.workItemByPath',
        expectedParams: {
          repoPath,
          repo: repoPath,
          host: 'gitea.example.com',
          path: 'team/repo',
          number: 9,
          type: 'issue'
        }
      }
    ]

    expect(routeCases.map((routeCase) => routeCase.key).sort()).toEqual(
      Object.keys(GITEA_WEB_RPC_METHODS).sort()
    )

    for (const routeCase of routeCases) {
      await routeCase.invoke(api.gitea)
    }

    expect(runtimeCalls).toEqual(
      routeCases.map((routeCase) => ({
        method: routeCase.expectedMethod,
        params: routeCase.expectedParams
      }))
    )
    expect(pagedResult.items[0]?.number).toBe(9)
  })
})

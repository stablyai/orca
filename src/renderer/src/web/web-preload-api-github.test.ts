import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installApi,
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

describe('web GitHub preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('keeps the web GitHub preload key set in parity with the preload contract', async () => {
    const { api } = await installApi('Linux')

    expect(Object.keys(api.gh).sort()).toEqual(
      [
        'addIssueComment',
        'addIssueCommentBySlug',
        'addPRReviewComment',
        'addPRReviewCommentReply',
        'checkOrcaStarred',
        'clearProjectItemField',
        'countWorkItems',
        'createIssue',
        'deleteIssueCommentBySlug',
        'diagnoseAuth',
        'enqueuePRRefresh',
        'getProjectViewTable',
        'issue',
        'listAccessibleProjects',
        'listAssignableUsers',
        'listAssignableUsersBySlug',
        'listIssueTypesBySlug',
        'listIssues',
        'listLabels',
        'listLabelsBySlug',
        'listProjectViews',
        'listWorkItems',
        'mergePR',
        'notifyWorkItemMutated',
        'onPRRefreshEvent',
        'onWorkItemMutated',
        'prCheckDetails',
        'prChecks',
        'prComments',
        'prFileContents',
        'prForBranch',
        'projectWorkItemDetailsBySlug',
        'rateLimit',
        'refreshPRNow',
        'removePRReviewers',
        'repoSlug',
        'repoUpstream',
        'reportVisiblePRRefreshCandidates',
        'rerunPRChecks',
        'requestPRReviewers',
        'resolveProjectRef',
        'resolveReviewThread',
        'setPRAutoMerge',
        'setPRCommentReaction',
        'setPRFileViewed',
        'starOrca',
        'updateIssue',
        'updateIssueBySlug',
        'updateIssueCommentBySlug',
        'updateIssueTypeBySlug',
        'updatePRState',
        'updatePRTitle',
        'updateProjectItemField',
        'updatePullRequestBySlug',
        'viewer',
        'workItem',
        'workItemByOwnerRepo',
        'workItemDetails'
      ].sort()
    )
  })

  it('routes every runtime-backed GitHub method through the expected RPC method', async () => {
    type GitHubApi = NonNullable<PreloadApi['gh']>
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { ok: true, items: [], count: 0 },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    const { GITHUB_WEB_RPC_METHODS } = await import('./preload-api/web-github-routes')
    installWebPreloadApi()
    const api = globals.window.api
    const repoPath = '/workspace/repo'
    const withRepo = (params: Record<string, unknown>): Record<string, unknown> => ({
      ...params,
      repo: repoPath
    })

    const routeCases: {
      key: keyof GitHubApi
      args?: unknown
      expectedMethod: string
      expectedParams: unknown
    }[] = [
      {
        key: 'repoSlug',
        args: { repoPath },
        expectedMethod: 'github.repoSlug',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'repoUpstream',
        args: { repoPath },
        expectedMethod: 'github.repoUpstream',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'prForBranch',
        args: { repoPath, branch: 'feature', linkedPRNumber: 3, fallbackPRNumber: null },
        expectedMethod: 'github.prForBranch',
        expectedParams: withRepo({
          repoPath,
          branch: 'feature',
          linkedPRNumber: 3,
          fallbackPRNumber: null
        })
      },
      {
        key: 'issue',
        args: { repoPath, number: 7 },
        expectedMethod: 'github.issue',
        expectedParams: withRepo({ repoPath, number: 7 })
      },
      {
        key: 'workItem',
        args: { repoPath, number: 7, type: 'issue' },
        expectedMethod: 'github.workItem',
        expectedParams: withRepo({ repoPath, number: 7, type: 'issue' })
      },
      {
        key: 'workItemByOwnerRepo',
        args: { repoPath, owner: 'acme', repo: 'orca', number: 7, type: 'pr' },
        expectedMethod: 'github.workItemByOwnerRepo',
        expectedParams: withRepo({
          repoPath,
          owner: 'acme',
          ownerRepo: 'orca',
          number: 7,
          type: 'pr'
        })
      },
      {
        key: 'workItemDetails',
        args: { repoPath, number: 7, type: 'issue' },
        expectedMethod: 'github.workItemDetails',
        expectedParams: withRepo({ repoPath, number: 7, type: 'issue' })
      },
      {
        key: 'prFileContents',
        args: {
          repoPath,
          prNumber: 7,
          path: 'src/app.ts',
          status: 'modified',
          headSha: 'head',
          baseSha: 'base'
        },
        expectedMethod: 'github.prFileContents',
        expectedParams: withRepo({
          repoPath,
          prNumber: 7,
          path: 'src/app.ts',
          status: 'modified',
          headSha: 'head',
          baseSha: 'base'
        })
      },
      {
        key: 'listIssues',
        args: { repoPath, limit: 10 },
        expectedMethod: 'github.listIssues',
        expectedParams: withRepo({ repoPath, limit: 10 })
      },
      {
        key: 'createIssue',
        args: { repoPath, title: 'Bug', body: 'Details' },
        expectedMethod: 'github.createIssue',
        expectedParams: withRepo({ repoPath, title: 'Bug', body: 'Details' })
      },
      {
        key: 'countWorkItems',
        args: { repoPath, query: 'is:open' },
        expectedMethod: 'github.countWorkItems',
        expectedParams: withRepo({ repoPath, query: 'is:open' })
      },
      {
        key: 'listWorkItems',
        args: { repoPath, limit: 20, query: 'is:pr', page: 2, noCache: true },
        expectedMethod: 'github.listWorkItems',
        expectedParams: withRepo({
          repoPath,
          limit: 20,
          query: 'is:pr',
          page: 2,
          noCache: true
        })
      },
      {
        key: 'prChecks',
        args: { repoPath, prNumber: 7, headSha: 'head', noCache: true },
        expectedMethod: 'github.prChecks',
        expectedParams: withRepo({ repoPath, prNumber: 7, headSha: 'head', noCache: true })
      },
      {
        key: 'prCheckDetails',
        args: { repoPath, checkRunId: 1, checkName: 'test' },
        expectedMethod: 'github.prCheckDetails',
        expectedParams: withRepo({ repoPath, checkRunId: 1, checkName: 'test' })
      },
      {
        key: 'rerunPRChecks',
        args: { repoPath, prNumber: 7, failedOnly: true },
        expectedMethod: 'github.rerunPRChecks',
        expectedParams: withRepo({ repoPath, prNumber: 7, failedOnly: true })
      },
      {
        key: 'prComments',
        args: { repoPath, prNumber: 7, noCache: true },
        expectedMethod: 'github.prComments',
        expectedParams: withRepo({ repoPath, prNumber: 7, noCache: true })
      },
      {
        key: 'setPRCommentReaction',
        args: { repoPath, reactionSubjectId: 'IC_1', content: 'heart', reacted: true },
        expectedMethod: 'github.setPRCommentReaction',
        expectedParams: withRepo({
          repoPath,
          reactionSubjectId: 'IC_1',
          content: 'heart',
          reacted: true
        })
      },
      {
        key: 'resolveReviewThread',
        args: { repoPath, threadId: 'thread-1', resolve: true },
        expectedMethod: 'github.resolveReviewThread',
        expectedParams: withRepo({ repoPath, threadId: 'thread-1', resolve: true })
      },
      {
        key: 'setPRFileViewed',
        args: { repoPath, prNumber: 7, pullRequestId: 'PR_kw', path: 'src/app.ts', viewed: true },
        expectedMethod: 'github.setPRFileViewed',
        expectedParams: withRepo({
          repoPath,
          prNumber: 7,
          pullRequestId: 'PR_kw',
          path: 'src/app.ts',
          viewed: true
        })
      },
      {
        key: 'updatePRTitle',
        args: { repoPath, prNumber: 7, title: 'New title' },
        expectedMethod: 'github.updatePRTitle',
        expectedParams: withRepo({ repoPath, prNumber: 7, title: 'New title' })
      },
      {
        key: 'mergePR',
        args: { repoPath, prNumber: 7, method: 'squash' },
        expectedMethod: 'github.mergePR',
        expectedParams: withRepo({ repoPath, prNumber: 7, method: 'squash' })
      },
      {
        key: 'setPRAutoMerge',
        args: { repoPath, prNumber: 7, enabled: true, method: 'squash' },
        expectedMethod: 'github.setPRAutoMerge',
        expectedParams: withRepo({ repoPath, prNumber: 7, enabled: true, method: 'squash' })
      },
      {
        key: 'updatePRState',
        args: { repoPath, prNumber: 7, updates: { state: 'closed' } },
        expectedMethod: 'github.updatePRState',
        expectedParams: withRepo({ repoPath, prNumber: 7, updates: { state: 'closed' } })
      },
      {
        key: 'requestPRReviewers',
        args: { repoPath, prNumber: 7, reviewers: ['alice'] },
        expectedMethod: 'github.requestPRReviewers',
        expectedParams: withRepo({ repoPath, prNumber: 7, reviewers: ['alice'] })
      },
      {
        key: 'removePRReviewers',
        args: { repoPath, prNumber: 7, reviewers: ['alice'] },
        expectedMethod: 'github.removePRReviewers',
        expectedParams: withRepo({ repoPath, prNumber: 7, reviewers: ['alice'] })
      },
      {
        key: 'updateIssue',
        args: { repoPath, number: 7, updates: { state: 'closed' } },
        expectedMethod: 'github.updateIssue',
        expectedParams: withRepo({ repoPath, number: 7, updates: { state: 'closed' } })
      },
      {
        key: 'addIssueComment',
        args: { repoPath, number: 7, body: 'Fixed', type: 'issue' },
        expectedMethod: 'github.addIssueComment',
        expectedParams: withRepo({ repoPath, number: 7, body: 'Fixed', type: 'issue' })
      },
      {
        key: 'addPRReviewCommentReply',
        args: { repoPath, prNumber: 7, commentId: 9, body: 'Reply' },
        expectedMethod: 'github.addPRReviewCommentReply',
        expectedParams: withRepo({ repoPath, prNumber: 7, commentId: 9, body: 'Reply' })
      },
      {
        key: 'addPRReviewComment',
        args: {
          repoPath,
          prNumber: 7,
          commitId: 'head',
          path: 'src/app.ts',
          line: 12,
          body: 'Fix'
        },
        expectedMethod: 'github.addPRReviewComment',
        expectedParams: withRepo({
          repoPath,
          prNumber: 7,
          commitId: 'head',
          path: 'src/app.ts',
          line: 12,
          body: 'Fix'
        })
      },
      {
        key: 'listLabels',
        args: { repoPath },
        expectedMethod: 'github.listLabels',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'listAssignableUsers',
        args: { repoPath },
        expectedMethod: 'github.listAssignableUsers',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'rateLimit',
        args: { force: true },
        expectedMethod: 'github.rateLimit',
        expectedParams: { force: true }
      },
      {
        key: 'listAccessibleProjects',
        args: { host: 'ghe.example.com' },
        expectedMethod: 'github.project.listAccessible',
        expectedParams: { host: 'ghe.example.com' }
      },
      {
        key: 'resolveProjectRef',
        args: { input: 'acme/1' },
        expectedMethod: 'github.project.resolveRef',
        expectedParams: { input: 'acme/1' }
      },
      {
        key: 'listProjectViews',
        args: { owner: 'acme', ownerType: 'organization', projectNumber: 1 },
        expectedMethod: 'github.project.listViews',
        expectedParams: { owner: 'acme', ownerType: 'organization', projectNumber: 1 }
      },
      {
        key: 'getProjectViewTable',
        args: { owner: 'acme', ownerType: 'organization', projectNumber: 1 },
        expectedMethod: 'github.project.viewTable',
        expectedParams: { owner: 'acme', ownerType: 'organization', projectNumber: 1 }
      },
      {
        key: 'projectWorkItemDetailsBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, type: 'issue' },
        expectedMethod: 'github.project.workItemDetailsBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, type: 'issue' }
      },
      {
        key: 'updateProjectItemField',
        args: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field', value: 'done' },
        expectedMethod: 'github.project.updateItemField',
        expectedParams: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field', value: 'done' }
      },
      {
        key: 'clearProjectItemField',
        args: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field' },
        expectedMethod: 'github.project.clearItemField',
        expectedParams: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field' }
      },
      {
        key: 'updateIssueBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } },
        expectedMethod: 'github.project.updateIssueBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } }
      },
      {
        key: 'updatePullRequestBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } },
        expectedMethod: 'github.project.updatePullRequestBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } }
      },
      {
        key: 'addIssueCommentBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, body: 'Fixed' },
        expectedMethod: 'github.project.addIssueCommentBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, body: 'Fixed' }
      },
      {
        key: 'updateIssueCommentBySlug',
        args: { owner: 'acme', repo: 'orca', commentId: 9, body: 'Edited' },
        expectedMethod: 'github.project.updateIssueCommentBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', commentId: 9, body: 'Edited' }
      },
      {
        key: 'deleteIssueCommentBySlug',
        args: { owner: 'acme', repo: 'orca', commentId: 9 },
        expectedMethod: 'github.project.deleteIssueCommentBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', commentId: 9 }
      },
      {
        key: 'listLabelsBySlug',
        args: { owner: 'acme', repo: 'orca' },
        expectedMethod: 'github.project.listLabelsBySlug',
        expectedParams: { owner: 'acme', repo: 'orca' }
      },
      {
        key: 'listAssignableUsersBySlug',
        args: { owner: 'acme', repo: 'orca', seedLogins: ['alice'] },
        expectedMethod: 'github.project.listAssignableUsersBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', seedLogins: ['alice'] }
      },
      {
        key: 'listIssueTypesBySlug',
        args: { owner: 'acme', repo: 'orca' },
        expectedMethod: 'github.project.listIssueTypesBySlug',
        expectedParams: { owner: 'acme', repo: 'orca' }
      },
      {
        key: 'updateIssueTypeBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, issueTypeId: 'it-1' },
        expectedMethod: 'github.project.updateIssueTypeBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, issueTypeId: 'it-1' }
      }
    ]

    expect(routeCases.map((routeCase) => routeCase.key).sort()).toEqual(
      Object.keys(GITHUB_WEB_RPC_METHODS).sort()
    )

    for (const routeCase of routeCases) {
      const method = api.gh[routeCase.key] as (args?: unknown) => Promise<unknown>
      await method(routeCase.args)
    }

    await api.gh.refreshPRNow({
      candidate: {
        cacheKey: 'repo-1:feature',
        repoKind: 'git',
        repoId: 'repo-1',
        repoPath,
        branch: 'feature',
        currentHeadOid: 'head-oid',
        linkedPRNumber: null,
        fallbackPRNumber: 9,
        fallbackPRSource: 'pr-cache'
      }
    })

    expect(runtimeCalls).toEqual([
      ...routeCases.map((routeCase) => ({
        method: routeCase.expectedMethod,
        params: routeCase.expectedParams
      })),
      {
        method: 'github.prForBranch',
        params: {
          repoPath,
          repoId: 'repo-1',
          repo: 'id:repo-1',
          branch: 'feature',
          linkedPRNumber: null,
          fallbackPRNumber: 9,
          currentHeadOid: 'head-oid',
          acceptMergedFallbackPR: true
        }
      }
    ])
  })
})

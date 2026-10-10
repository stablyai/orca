import type { PreloadApi } from '../../../../preload/api-types'
import {
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/protocol-version'
import { GITLAB_WEB_RPC_METHODS } from './web-gitlab-routes'
import type { WebGitLabRuntimeMethod } from './web-gitlab-routes'
import { mapRepoPathArg } from './web-review-api'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'

export type WebGitLabApi = NonNullable<PreloadApi['gl']>

export type WebGitLabResult<K extends keyof WebGitLabApi> = Awaited<ReturnType<WebGitLabApi[K]>>

export function createGitLabApi(): WebGitLabApi {
  const route = <Result>(method: WebGitLabRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))

  const gitLabApi = {
    viewer: () => Promise.resolve(null),
    diagnoseAuth: () => route<WebGitLabResult<'diagnoseAuth'>>(GITLAB_WEB_RPC_METHODS.diagnoseAuth),
    rateLimit: (args) =>
      route<WebGitLabResult<'rateLimit'>>(GITLAB_WEB_RPC_METHODS.rateLimit, args),
    projectSlug: () => Promise.resolve(null),
    mrForBranch: () => Promise.resolve(null),
    mr: () => Promise.resolve(null),
    listMRs: (args) => route<WebGitLabResult<'listMRs'>>(GITLAB_WEB_RPC_METHODS.listMRs, args),
    listWorkItems: (args) =>
      route<WebGitLabResult<'listWorkItems'>>(GITLAB_WEB_RPC_METHODS.listWorkItems, args),
    issue: () => Promise.resolve(null),
    listIssues: (args) =>
      route<WebGitLabResult<'listIssues'>>(GITLAB_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<WebGitLabResult<'createIssue'>>(GITLAB_WEB_RPC_METHODS.createIssue, args),
    updateIssue: (args) =>
      route<WebGitLabResult<'updateIssue'>>(GITLAB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<WebGitLabResult<'addIssueComment'>>(GITLAB_WEB_RPC_METHODS.addIssueComment, args),
    listLabels: (args) =>
      route<WebGitLabResult<'listLabels'>>(GITLAB_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: () => Promise.resolve([]),
    todos: (args) => route<WebGitLabResult<'todos'>>(GITLAB_WEB_RPC_METHODS.todos, args),
    workItemDetails: ({ repoOwnerExecutionHostId: _owner, ...args }) =>
      route<WebGitLabResult<'workItemDetails'>>(GITLAB_WEB_RPC_METHODS.workItemDetails, args),
    closeMR: (args) =>
      route<WebGitLabResult<'closeMR'>>(GITLAB_WEB_RPC_METHODS.closeMR, {
        ...args,
        state: 'closed'
      }),
    reopenMR: (args) =>
      route<WebGitLabResult<'reopenMR'>>(GITLAB_WEB_RPC_METHODS.reopenMR, {
        ...args,
        state: 'opened'
      }),
    mergeMR: (args) => route<WebGitLabResult<'mergeMR'>>(GITLAB_WEB_RPC_METHODS.mergeMR, args),
    updateMR: async (args) => {
      if (args.updates.readyForReview) {
        const status = await getRemoteRuntimeStatus().catch(() => null)
        if (!status?.capabilities?.includes(GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY)) {
          return { ok: false, error: GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE }
        }
      }
      return route<WebGitLabResult<'updateMR'>>(GITLAB_WEB_RPC_METHODS.updateMR, args)
    },
    updateMRReviewers: (args) =>
      route<WebGitLabResult<'updateMRReviewers'>>(GITLAB_WEB_RPC_METHODS.updateMRReviewers, args),
    addMRComment: (args) =>
      route<WebGitLabResult<'addMRComment'>>(GITLAB_WEB_RPC_METHODS.addMRComment, args),
    addMRInlineComment: (args) =>
      route<WebGitLabResult<'addMRInlineComment'>>(GITLAB_WEB_RPC_METHODS.addMRInlineComment, args),
    resolveMRDiscussion: (args) =>
      route<WebGitLabResult<'resolveMRDiscussion'>>(
        GITLAB_WEB_RPC_METHODS.resolveMRDiscussion,
        args
      ),
    jobTrace: (args) => route<WebGitLabResult<'jobTrace'>>(GITLAB_WEB_RPC_METHODS.jobTrace, args),
    retryJob: (args) => route<WebGitLabResult<'retryJob'>>(GITLAB_WEB_RPC_METHODS.retryJob, args),
    workItemByPath: (args) =>
      route<WebGitLabResult<'workItemByPath'>>(GITLAB_WEB_RPC_METHODS.workItemByPath, args)
  } satisfies WebGitLabApi

  return gitLabApi
}

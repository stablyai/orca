import type { PreloadApi } from '../../../preload/api-types'
import {
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE,
  type RuntimeCapability
} from '../../../shared/protocol-version'
import {
  GITLAB_WEB_RPC_METHODS,
  type WebGitLabRuntimeMethod
} from '@/web/preload-api/web-gitlab-routes'
import { mapRepoPathArg } from './runtime-repo-selector-params'

export type GitLabApi = NonNullable<PreloadApi['gl']>

type GitLabApiResult<K extends keyof GitLabApi> = Awaited<ReturnType<GitLabApi[K]>>

export type RuntimeGitLabTransport = {
  call: <Result>(method: WebGitLabRuntimeMethod, params?: unknown) => Promise<Result>
  supportsCapability: (capability: RuntimeCapability) => Promise<boolean>
}

/** The `gl` API spoken over runtime RPC to the server that owns the repo. */
export function createRuntimeGitLabApi(transport: RuntimeGitLabTransport): GitLabApi {
  const route = <Result>(method: WebGitLabRuntimeMethod, args?: unknown): Promise<Result> =>
    transport.call<Result>(method, mapRepoPathArg(args))

  return {
    viewer: () => Promise.resolve(null),
    diagnoseAuth: () => route<GitLabApiResult<'diagnoseAuth'>>(GITLAB_WEB_RPC_METHODS.diagnoseAuth),
    rateLimit: (args) =>
      route<GitLabApiResult<'rateLimit'>>(GITLAB_WEB_RPC_METHODS.rateLimit, args),
    projectSlug: () => Promise.resolve(null),
    mrForBranch: () => Promise.resolve(null),
    mr: () => Promise.resolve(null),
    listMRs: (args) => route<GitLabApiResult<'listMRs'>>(GITLAB_WEB_RPC_METHODS.listMRs, args),
    listWorkItems: (args) =>
      route<GitLabApiResult<'listWorkItems'>>(GITLAB_WEB_RPC_METHODS.listWorkItems, args),
    issue: () => Promise.resolve(null),
    listIssues: (args) =>
      route<GitLabApiResult<'listIssues'>>(GITLAB_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<GitLabApiResult<'createIssue'>>(GITLAB_WEB_RPC_METHODS.createIssue, args),
    updateIssue: (args) =>
      route<GitLabApiResult<'updateIssue'>>(GITLAB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<GitLabApiResult<'addIssueComment'>>(GITLAB_WEB_RPC_METHODS.addIssueComment, args),
    listLabels: (args) =>
      route<GitLabApiResult<'listLabels'>>(GITLAB_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: () => Promise.resolve([]),
    todos: (args) => route<GitLabApiResult<'todos'>>(GITLAB_WEB_RPC_METHODS.todos, args),
    // Why: the owner guard names a host as this client sees it; the server resolves the repo itself.
    workItemDetails: ({ repoOwnerExecutionHostId: _owner, ...args }) =>
      route<GitLabApiResult<'workItemDetails'>>(GITLAB_WEB_RPC_METHODS.workItemDetails, args),
    closeMR: (args) =>
      route<GitLabApiResult<'closeMR'>>(GITLAB_WEB_RPC_METHODS.closeMR, {
        ...args,
        state: 'closed'
      }),
    reopenMR: (args) =>
      route<GitLabApiResult<'reopenMR'>>(GITLAB_WEB_RPC_METHODS.reopenMR, {
        ...args,
        state: 'opened'
      }),
    mergeMR: (args) => route<GitLabApiResult<'mergeMR'>>(GITLAB_WEB_RPC_METHODS.mergeMR, args),
    updateMR: async (args) => {
      if (
        args.updates.readyForReview &&
        !(await transport.supportsCapability(GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY))
      ) {
        return { ok: false, error: GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE }
      }
      return route<GitLabApiResult<'updateMR'>>(GITLAB_WEB_RPC_METHODS.updateMR, args)
    },
    updateMRReviewers: (args) =>
      route<GitLabApiResult<'updateMRReviewers'>>(GITLAB_WEB_RPC_METHODS.updateMRReviewers, args),
    addMRComment: (args) =>
      route<GitLabApiResult<'addMRComment'>>(GITLAB_WEB_RPC_METHODS.addMRComment, args),
    addMRInlineComment: (args) =>
      route<GitLabApiResult<'addMRInlineComment'>>(GITLAB_WEB_RPC_METHODS.addMRInlineComment, args),
    resolveMRDiscussion: (args) =>
      route<GitLabApiResult<'resolveMRDiscussion'>>(
        GITLAB_WEB_RPC_METHODS.resolveMRDiscussion,
        args
      ),
    jobTrace: (args) => route<GitLabApiResult<'jobTrace'>>(GITLAB_WEB_RPC_METHODS.jobTrace, args),
    retryJob: (args) => route<GitLabApiResult<'retryJob'>>(GITLAB_WEB_RPC_METHODS.retryJob, args),
    workItemByPath: (args) =>
      route<GitLabApiResult<'workItemByPath'>>(GITLAB_WEB_RPC_METHODS.workItemByPath, args)
  } satisfies GitLabApi
}

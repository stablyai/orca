import type { PreloadApi } from '../../../../preload/api-types'
import {
  GITLAB_ISSUE_SEARCH_RUNTIME_CAPABILITY,
  GITLAB_ISSUE_SEARCH_UPDATE_REQUIRED_MESSAGE,
  GITLAB_LIST_LABELS_RUNTIME_CAPABILITY,
  GITLAB_LIST_LABELS_UPDATE_REQUIRED_MESSAGE,
  GITLAB_MR_INVOLVEMENT_RUNTIME_CAPABILITY,
  GITLAB_MR_INVOLVEMENT_UPDATE_REQUIRED_MESSAGE,
  GITLAB_READY_FOR_REVIEW_RUNTIME_CAPABILITY,
  GITLAB_READY_FOR_REVIEW_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/source-control/runtime/source-control-runtime-capabilities'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'
import {
  GITLAB_WEB_RPC_METHODS,
  type WebGitLabRuntimeMethod
} from '@/web/preload-api/gitlab/web-gitlab-routes'
import { mapRepoPathArg } from '../source-control/forge/runtime-repo-selector-params'
import { hasRuntimeRpcErrorCode } from '../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'

export type GitLabApi = NonNullable<PreloadApi['gl']>

type GitLabApiResult<K extends keyof GitLabApi> = Awaited<ReturnType<GitLabApi[K]>>

/** Thrown by a transport whose runtime answered that it lacks a call's required capability. */
export class RuntimeCapabilityMissingError extends Error {}

export type RuntimeGitLabTransport = {
  // A required capability is checked on the same runtime that then serves the call.
  call: <Result>(
    method: WebGitLabRuntimeMethod,
    params?: unknown,
    options?: { requiredCapability?: RuntimeCapability }
  ) => Promise<Result>
  supportsCapability: (capability: RuntimeCapability) => Promise<boolean>
}

/** The `gl` API spoken over runtime RPC to the server that owns the repo. */
export function createRuntimeGitLabApi(transport: RuntimeGitLabTransport): GitLabApi {
  const route = <Result>(method: WebGitLabRuntimeMethod, args?: unknown): Promise<Result> =>
    transport.call<Result>(method, mapRepoPathArg(args))
  // Why: a server without the capability drops the filter and would answer with an unfiltered list.
  const routeRequiring = async <Result>(
    method: WebGitLabRuntimeMethod,
    args: unknown,
    requiredCapability: RuntimeCapability,
    refusal: Result
  ): Promise<Result> => {
    try {
      return await transport.call<Result>(method, mapRepoPathArg(args), { requiredCapability })
    } catch (error) {
      if (error instanceof RuntimeCapabilityMissingError) {
        return refusal
      }
      throw error
    }
  }

  return {
    viewer: () => Promise.resolve(null),
    diagnoseAuth: () => route<GitLabApiResult<'diagnoseAuth'>>(GITLAB_WEB_RPC_METHODS.diagnoseAuth),
    rateLimit: (args) =>
      route<GitLabApiResult<'rateLimit'>>(GITLAB_WEB_RPC_METHODS.rateLimit, args),
    projectSlug: () => Promise.resolve(null),
    mrForBranch: () => Promise.resolve(null),
    mr: () => Promise.resolve(null),
    listMRs: (args) => {
      const method = GITLAB_WEB_RPC_METHODS.listMRs
      const refusal = (message: string): GitLabApiResult<'listMRs'> => ({
        items: [],
        page: args.page ?? 1,
        perPage: args.perPage ?? 20,
        totalCount: 0,
        totalPages: 0,
        error: { type: 'unknown', message }
      })
      // Why labels alone: a server with the labels capability also has the older involvement one.
      if (args.labels?.length) {
        return routeRequiring(
          method,
          args,
          GITLAB_LIST_LABELS_RUNTIME_CAPABILITY,
          refusal(GITLAB_LIST_LABELS_UPDATE_REQUIRED_MESSAGE)
        )
      }
      if (args.involvement) {
        return routeRequiring(
          method,
          args,
          GITLAB_MR_INVOLVEMENT_RUNTIME_CAPABILITY,
          refusal(GITLAB_MR_INVOLVEMENT_UPDATE_REQUIRED_MESSAGE)
        )
      }
      return route<GitLabApiResult<'listMRs'>>(method, args)
    },
    listWorkItems: (args) =>
      route<GitLabApiResult<'listWorkItems'>>(GITLAB_WEB_RPC_METHODS.listWorkItems, args),
    issue: () => Promise.resolve(null),
    listIssues: (args) => {
      const method = GITLAB_WEB_RPC_METHODS.listIssues
      const refusal = (message: string): GitLabApiResult<'listIssues'> => ({
        items: [],
        totalPages: 0,
        error: { type: 'unknown', message }
      })
      // Why labels alone: a server with the labels capability also takes the issue search.
      if (args.labels?.length) {
        return routeRequiring(
          method,
          args,
          GITLAB_LIST_LABELS_RUNTIME_CAPABILITY,
          refusal(GITLAB_LIST_LABELS_UPDATE_REQUIRED_MESSAGE)
        )
      }
      if (args.query?.trim()) {
        return routeRequiring(
          method,
          args,
          GITLAB_ISSUE_SEARCH_RUNTIME_CAPABILITY,
          refusal(GITLAB_ISSUE_SEARCH_UPDATE_REQUIRED_MESSAGE)
        )
      }
      return route<GitLabApiResult<'listIssues'>>(method, args)
    },
    createIssue: (args) =>
      route<GitLabApiResult<'createIssue'>>(GITLAB_WEB_RPC_METHODS.createIssue, args),
    updateIssue: (args) =>
      route<GitLabApiResult<'updateIssue'>>(GITLAB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<GitLabApiResult<'addIssueComment'>>(GITLAB_WEB_RPC_METHODS.addIssueComment, args),
    listLabels: (args) =>
      route<GitLabApiResult<'listLabels'>>(GITLAB_WEB_RPC_METHODS.listLabels, args),
    // Why empty on method_not_found: a host older than this RPC simply offers no reviewers.
    listAssignableUsers: (args) =>
      route<GitLabApiResult<'listAssignableUsers'>>(
        GITLAB_WEB_RPC_METHODS.listAssignableUsers,
        args
      ).catch((error: unknown) => {
        if (hasRuntimeRpcErrorCode(error, 'method_not_found')) {
          return []
        }
        throw error
      }),
    todos: (args) => route<GitLabApiResult<'todos'>>(GITLAB_WEB_RPC_METHODS.todos, args),
    // Why: the owner guard names a host as this client sees it; the server resolves the repo itself.
    // A remote host gates its own polls; `background` is a local IPC hint only.
    workItemDetails: ({ repoOwnerExecutionHostId: _owner, background: _background, ...args }) =>
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

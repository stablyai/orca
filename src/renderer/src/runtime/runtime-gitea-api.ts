import type { PreloadApi } from '../../../preload/api-types'
import { mapRepoPathArg } from '@/runtime/runtime-repo-selector-params'
import {
  GITEA_WEB_RPC_METHODS,
  type WebGiteaRuntimeMethod
} from '@/web/preload-api/web-gitea-routes'

export type WebGiteaApi = NonNullable<PreloadApi['gitea']>

type GiteaApiResult<K extends keyof WebGiteaApi> = Awaited<ReturnType<WebGiteaApi[K]>>

export type RuntimeGiteaTransport = {
  call: <Result>(method: WebGiteaRuntimeMethod, params?: unknown) => Promise<Result>
}

/** The `gitea` API spoken over runtime RPC to the server that owns the repo. */
export function createRuntimeGiteaApi(transport: RuntimeGiteaTransport): WebGiteaApi {
  const route = <Result>(method: WebGiteaRuntimeMethod, args?: unknown): Promise<Result> =>
    transport.call<Result>(method, mapRepoPathArg(args))

  return {
    viewer: () => route<GiteaApiResult<'viewer'>>(GITEA_WEB_RPC_METHODS.viewer),
    diagnoseAuth: () => route<GiteaApiResult<'diagnoseAuth'>>(GITEA_WEB_RPC_METHODS.diagnoseAuth),
    rateLimit: (args) => route<GiteaApiResult<'rateLimit'>>(GITEA_WEB_RPC_METHODS.rateLimit, args),
    projectSlug: (args) =>
      route<GiteaApiResult<'projectSlug'>>(GITEA_WEB_RPC_METHODS.projectSlug, args),
    prForBranch: (args) =>
      route<GiteaApiResult<'prForBranch'>>(GITEA_WEB_RPC_METHODS.prForBranch, args),
    pr: (args) => route<GiteaApiResult<'pr'>>(GITEA_WEB_RPC_METHODS.pr, args),
    listPRs: (args) => route<GiteaApiResult<'listPRs'>>(GITEA_WEB_RPC_METHODS.listPRs, args),
    listWorkItems: (args) =>
      route<GiteaApiResult<'listWorkItems'>>(GITEA_WEB_RPC_METHODS.listWorkItems, args),
    issue: (args) => route<GiteaApiResult<'issue'>>(GITEA_WEB_RPC_METHODS.issue, args),
    listIssues: (args) =>
      route<GiteaApiResult<'listIssues'>>(GITEA_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<GiteaApiResult<'createIssue'>>(GITEA_WEB_RPC_METHODS.createIssue, args),
    updateIssue: (args) =>
      route<GiteaApiResult<'updateIssue'>>(GITEA_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<GiteaApiResult<'addIssueComment'>>(GITEA_WEB_RPC_METHODS.addIssueComment, args),
    listLabels: (args) =>
      route<GiteaApiResult<'listLabels'>>(GITEA_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: (args) =>
      route<GiteaApiResult<'listAssignableUsers'>>(GITEA_WEB_RPC_METHODS.listAssignableUsers, args),
    notifications: (args) =>
      route<GiteaApiResult<'notifications'>>(GITEA_WEB_RPC_METHODS.notifications, args),
    markNotificationRead: (args) =>
      route<GiteaApiResult<'markNotificationRead'>>(
        GITEA_WEB_RPC_METHODS.markNotificationRead,
        args
      ),
    // The owner guard and background flag name a local host; the server resolves the repo itself.
    workItemDetails: ({ repoOwnerExecutionHostId: _owner, background: _background, ...args }) =>
      route<GiteaApiResult<'workItemDetails'>>(GITEA_WEB_RPC_METHODS.workItemDetails, args),
    closePR: (args) =>
      route<GiteaApiResult<'closePR'>>(GITEA_WEB_RPC_METHODS.closePR, { ...args, state: 'closed' }),
    reopenPR: (args) =>
      route<GiteaApiResult<'reopenPR'>>(GITEA_WEB_RPC_METHODS.reopenPR, { ...args, state: 'open' }),
    mergePR: (args) => route<GiteaApiResult<'mergePR'>>(GITEA_WEB_RPC_METHODS.mergePR, args),
    updatePR: (args) => route<GiteaApiResult<'updatePR'>>(GITEA_WEB_RPC_METHODS.updatePR, args),
    updatePRReviewers: (args) =>
      route<GiteaApiResult<'updatePRReviewers'>>(GITEA_WEB_RPC_METHODS.updatePRReviewers, args),
    addPRComment: (args) =>
      route<GiteaApiResult<'addPRComment'>>(GITEA_WEB_RPC_METHODS.addPRComment, args),
    addPRInlineComment: (args) =>
      route<GiteaApiResult<'addPRInlineComment'>>(GITEA_WEB_RPC_METHODS.addPRInlineComment, args),
    resolvePRDiscussion: (args) =>
      route<GiteaApiResult<'resolvePRDiscussion'>>(GITEA_WEB_RPC_METHODS.resolvePRDiscussion, args),
    submitPRReview: (args) =>
      route<GiteaApiResult<'submitPRReview'>>(GITEA_WEB_RPC_METHODS.submitPRReview, args),
    jobTrace: (args) => route<GiteaApiResult<'jobTrace'>>(GITEA_WEB_RPC_METHODS.jobTrace, args),
    workItemByPath: (args) =>
      route<GiteaApiResult<'workItemByPath'>>(GITEA_WEB_RPC_METHODS.workItemByPath, args)
  }
}

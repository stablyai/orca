import type { PreloadApi } from '../../../../preload/api-types'
import {
  GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY,
  GITHUB_MARK_PR_READY_UPDATE_REQUIRED_MESSAGE
} from '../../../../shared/protocol-version'
import { translate } from '@/i18n/i18n'
import { GITHUB_WEB_RPC_METHODS } from './web-github-routes'
import type { WebGitHubRuntimeMethod } from './web-github-routes'
import { mapRepoPathArg } from './web-review-api'
import { callRuntimeResult, getRemoteRuntimeStatus } from './web-runtime-calls'
import { noopUnsubscribe } from './web-storage'

export type WebGitHubApi = NonNullable<PreloadApi['gh']>

export type WebGitHubResult<K extends keyof WebGitHubApi> = Awaited<ReturnType<WebGitHubApi[K]>>

/** Expose the same GitHub/Actions API surface to web clients through authenticated runtime RPC. */
export function createGitHubApi(): WebGitHubApi {
  const route = <Result>(method: WebGitHubRuntimeMethod, args?: unknown): Promise<Result> =>
    callRuntimeResult<Result>(method, mapRepoPathArg(args))
  const githubApi = {
    /** Read artifact metadata using the caller’s registered repository, run and account context. */
    actionsArtifacts: (args) =>
      route<WebGitHubResult<'actionsArtifacts'>>(GITHUB_WEB_RPC_METHODS.actionsArtifacts, args),
    /** Acquire an owner-bound archive; the returned transfer must be released after save or cancellation. */
    startActionsArtifactDownload: (args) =>
      route<WebGitHubResult<'startActionsArtifactDownload'>>(
        GITHUB_WEB_RPC_METHODS.startActionsArtifactDownload,
        args
      ),
    /** Read a bounded archive chunk using the original transfer’s repository and account context. */
    readActionsArtifactChunk: (args) =>
      route<WebGitHubResult<'readActionsArtifactChunk'>>(
        GITHUB_WEB_RPC_METHODS.readActionsArtifactChunk,
        args
      ),
    /** Release retained archive storage using the original transfer owner, including after failed saves. */
    releaseActionsArtifactDownload: (args) =>
      route<WebGitHubResult<'releaseActionsArtifactDownload'>>(
        GITHUB_WEB_RPC_METHODS.releaseActionsArtifactDownload,
        args
      ),

    /** Read a filtered run page on the registered repository’s execution host and account. */
    actionsRuns: (args) =>
      route<WebGitHubResult<'actionsRuns'>>(GITHUB_WEB_RPC_METHODS.actionsRuns, args),
    /** Read a workflow page using the same repository owner as run browsing. */
    actionsWorkflows: (args) =>
      route<WebGitHubResult<'actionsWorkflows'>>(GITHUB_WEB_RPC_METHODS.actionsWorkflows, args),
    /** Read jobs for the selected run attempt and page using its pinned repository owner. */
    actionsRunDetails: (args) =>
      route<WebGitHubResult<'actionsRunDetails'>>(GITHUB_WEB_RPC_METHODS.actionsRunDetails, args),
    viewer: () => Promise.resolve(null),
    repoSlug: (args) => route<WebGitHubResult<'repoSlug'>>(GITHUB_WEB_RPC_METHODS.repoSlug, args),
    repoUpstream: (args) =>
      route<WebGitHubResult<'repoUpstream'>>(GITHUB_WEB_RPC_METHODS.repoUpstream, args),
    prForBranch: (args) =>
      route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, args),
    refreshPRNow: async ({ candidate, reason }) => {
      const acceptMergedFallbackPR =
        candidate.linkedPRNumber == null &&
        candidate.fallbackPRNumber != null &&
        candidate.fallbackPRSource != null
      const pr = await route<WebGitHubResult<'prForBranch'>>(GITHUB_WEB_RPC_METHODS.prForBranch, {
        repoPath: candidate.repoPath,
        repoId: candidate.repoId,
        branch: candidate.branch,
        linkedPRNumber: candidate.linkedPRNumber ?? null,
        fallbackPRNumber: candidate.fallbackPRNumber ?? null,
        currentHeadOid: candidate.currentHeadOid ?? null,
        ...(reason ? { reason } : {}),
        ...(acceptMergedFallbackPR ? { acceptMergedFallbackPR: true } : {})
      })
      return pr
        ? { kind: 'found', pr, fetchedAt: Date.now() }
        : { kind: 'no-pr', fetchedAt: Date.now() }
    },
    enqueuePRRefresh: () => Promise.resolve(false),
    reportVisiblePRRefreshCandidates: () => Promise.resolve(false),
    onPRRefreshEvent: () => noopUnsubscribe,
    issue: (args) => route<WebGitHubResult<'issue'>>(GITHUB_WEB_RPC_METHODS.issue, args),
    workItem: (args) => route<WebGitHubResult<'workItem'>>(GITHUB_WEB_RPC_METHODS.workItem, args),
    workItemByOwnerRepo: ({ repo: ownerRepo, ...args }) =>
      route<WebGitHubResult<'workItemByOwnerRepo'>>(GITHUB_WEB_RPC_METHODS.workItemByOwnerRepo, {
        ...args,
        ownerRepo
      }),
    workItemDetails: (args) =>
      route<WebGitHubResult<'workItemDetails'>>(GITHUB_WEB_RPC_METHODS.workItemDetails, args),
    notifyWorkItemMutated: () => Promise.resolve(false),
    prFileContents: (args) =>
      route<WebGitHubResult<'prFileContents'>>(GITHUB_WEB_RPC_METHODS.prFileContents, args),
    listIssues: (args) =>
      route<WebGitHubResult<'listIssues'>>(GITHUB_WEB_RPC_METHODS.listIssues, args),
    createIssue: (args) =>
      route<WebGitHubResult<'createIssue'>>(GITHUB_WEB_RPC_METHODS.createIssue, args),
    countWorkItems: (args) =>
      route<WebGitHubResult<'countWorkItems'>>(GITHUB_WEB_RPC_METHODS.countWorkItems, args),
    listWorkItems: (args) =>
      route<WebGitHubResult<'listWorkItems'>>(GITHUB_WEB_RPC_METHODS.listWorkItems, args),
    prChecks: (args) => route<WebGitHubResult<'prChecks'>>(GITHUB_WEB_RPC_METHODS.prChecks, args),
    prCheckDetails: (args) =>
      route<WebGitHubResult<'prCheckDetails'>>(GITHUB_WEB_RPC_METHODS.prCheckDetails, args),
    rerunPRChecks: (args) =>
      route<WebGitHubResult<'rerunPRChecks'>>(GITHUB_WEB_RPC_METHODS.rerunPRChecks, args),
    prComments: (args) =>
      route<WebGitHubResult<'prComments'>>(GITHUB_WEB_RPC_METHODS.prComments, args),
    setPRCommentReaction: (args) =>
      route<WebGitHubResult<'setPRCommentReaction'>>(
        GITHUB_WEB_RPC_METHODS.setPRCommentReaction,
        args
      ),
    resolveReviewThread: (args) =>
      route<WebGitHubResult<'resolveReviewThread'>>(
        GITHUB_WEB_RPC_METHODS.resolveReviewThread,
        args
      ),
    setPRFileViewed: (args) =>
      route<WebGitHubResult<'setPRFileViewed'>>(GITHUB_WEB_RPC_METHODS.setPRFileViewed, args),
    updatePRTitle: (args) =>
      route<WebGitHubResult<'updatePRTitle'>>(GITHUB_WEB_RPC_METHODS.updatePRTitle, args),
    mergePR: (args) => route<WebGitHubResult<'mergePR'>>(GITHUB_WEB_RPC_METHODS.mergePR, args),
    markPRReadyForReview: async (args) => {
      const status = await getRemoteRuntimeStatus().catch(() => null)
      if (!status?.capabilities?.includes(GITHUB_MARK_PR_READY_RUNTIME_CAPABILITY)) {
        return { ok: false, error: GITHUB_MARK_PR_READY_UPDATE_REQUIRED_MESSAGE }
      }
      return route<WebGitHubResult<'markPRReadyForReview'>>(
        GITHUB_WEB_RPC_METHODS.markPRReadyForReview,
        args
      )
    },
    setPRAutoMerge: (args) =>
      route<WebGitHubResult<'setPRAutoMerge'>>(GITHUB_WEB_RPC_METHODS.setPRAutoMerge, args),
    updatePRState: (args) =>
      route<WebGitHubResult<'updatePRState'>>(GITHUB_WEB_RPC_METHODS.updatePRState, args),
    requestPRReviewers: (args) =>
      route<WebGitHubResult<'requestPRReviewers'>>(GITHUB_WEB_RPC_METHODS.requestPRReviewers, args),
    removePRReviewers: (args) =>
      route<WebGitHubResult<'removePRReviewers'>>(GITHUB_WEB_RPC_METHODS.removePRReviewers, args),
    updateIssue: (args) =>
      route<WebGitHubResult<'updateIssue'>>(GITHUB_WEB_RPC_METHODS.updateIssue, args),
    addIssueComment: (args) =>
      route<WebGitHubResult<'addIssueComment'>>(GITHUB_WEB_RPC_METHODS.addIssueComment, args),
    addPRReviewCommentReply: (args) =>
      route<WebGitHubResult<'addPRReviewCommentReply'>>(
        GITHUB_WEB_RPC_METHODS.addPRReviewCommentReply,
        args
      ),
    addPRReviewComment: (args) =>
      route<WebGitHubResult<'addPRReviewComment'>>(GITHUB_WEB_RPC_METHODS.addPRReviewComment, args),
    listLabels: (args) =>
      route<WebGitHubResult<'listLabels'>>(GITHUB_WEB_RPC_METHODS.listLabels, args),
    listAssignableUsers: (args) =>
      route<WebGitHubResult<'listAssignableUsers'>>(
        GITHUB_WEB_RPC_METHODS.listAssignableUsers,
        args
      ),
    onWorkItemMutated: () => noopUnsubscribe,
    checkOrcaStarred: () => Promise.resolve(null),
    starOrca: () => Promise.resolve(false),
    rateLimit: (args) =>
      route<WebGitHubResult<'rateLimit'>>(GITHUB_WEB_RPC_METHODS.rateLimit, args),
    listBindableAccounts: (args) =>
      route<WebGitHubResult<'listBindableAccounts'>>(
        GITHUB_WEB_RPC_METHODS.listBindableAccounts,
        args
      ),
    validateAccountBinding: (args) =>
      route<WebGitHubResult<'validateAccountBinding'>>(
        GITHUB_WEB_RPC_METHODS.validateAccountBinding,
        args
      ),
    diagnoseAuth: () =>
      Promise.resolve({
        ok: false,
        message: translate('auto.web.web.preload.api.31bfe8ae1a', 'Unavailable in the web client.')
      } as never),
    listAccessibleProjects: (args) =>
      route<WebGitHubResult<'listAccessibleProjects'>>(
        GITHUB_WEB_RPC_METHODS.listAccessibleProjects,
        args
      ),
    resolveProjectRef: (args) =>
      route<WebGitHubResult<'resolveProjectRef'>>(GITHUB_WEB_RPC_METHODS.resolveProjectRef, args),
    listProjectViews: (args) =>
      route<WebGitHubResult<'listProjectViews'>>(GITHUB_WEB_RPC_METHODS.listProjectViews, args),
    getProjectViewTable: (args) =>
      route<WebGitHubResult<'getProjectViewTable'>>(
        GITHUB_WEB_RPC_METHODS.getProjectViewTable,
        args
      ),
    projectWorkItemDetailsBySlug: (args) =>
      route<WebGitHubResult<'projectWorkItemDetailsBySlug'>>(
        GITHUB_WEB_RPC_METHODS.projectWorkItemDetailsBySlug,
        args
      ),
    updateProjectItemField: (args) =>
      route<WebGitHubResult<'updateProjectItemField'>>(
        GITHUB_WEB_RPC_METHODS.updateProjectItemField,
        args
      ),
    clearProjectItemField: (args) =>
      route<WebGitHubResult<'clearProjectItemField'>>(
        GITHUB_WEB_RPC_METHODS.clearProjectItemField,
        args
      ),
    updateIssueBySlug: (args) =>
      route<WebGitHubResult<'updateIssueBySlug'>>(GITHUB_WEB_RPC_METHODS.updateIssueBySlug, args),
    updatePullRequestBySlug: (args) =>
      route<WebGitHubResult<'updatePullRequestBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updatePullRequestBySlug,
        args
      ),
    addIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'addIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.addIssueCommentBySlug,
        args
      ),
    updateIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'updateIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updateIssueCommentBySlug,
        args
      ),
    deleteIssueCommentBySlug: (args) =>
      route<WebGitHubResult<'deleteIssueCommentBySlug'>>(
        GITHUB_WEB_RPC_METHODS.deleteIssueCommentBySlug,
        args
      ),
    listLabelsBySlug: (args) =>
      route<WebGitHubResult<'listLabelsBySlug'>>(GITHUB_WEB_RPC_METHODS.listLabelsBySlug, args),
    listAssignableUsersBySlug: (args) =>
      route<WebGitHubResult<'listAssignableUsersBySlug'>>(
        GITHUB_WEB_RPC_METHODS.listAssignableUsersBySlug,
        args
      ),
    listIssueTypesBySlug: (args) =>
      route<WebGitHubResult<'listIssueTypesBySlug'>>(
        GITHUB_WEB_RPC_METHODS.listIssueTypesBySlug,
        args
      ),
    updateIssueTypeBySlug: (args) =>
      route<WebGitHubResult<'updateIssueTypeBySlug'>>(
        GITHUB_WEB_RPC_METHODS.updateIssueTypeBySlug,
        args
      )
  } satisfies WebGitHubApi

  return githubApi
}

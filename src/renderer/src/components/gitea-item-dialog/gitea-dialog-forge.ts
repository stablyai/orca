import { giteaApiFor } from '@/runtime/gitea-owner-api'
import { withGitLabIpcTimeout } from '@/runtime/gitlab-ipc-timeout'
import { translate } from '@/i18n/i18n'
import type { GiteaApi, GiteaRepoSelectorArgs } from '../../../../preload/api/gitea-api'
import type { GitLabDialogForge } from '../gitlab-item-dialog/gitlab-dialog-forge'
import type { GitLabDialogRepoSelector } from '../gitlab-item-dialog/gitlab-item-dialog-types'
import { GiteaReviewerIds, giteaDetailsToDialogDetails } from './gitea-dialog-mappers'

const GITEA_JOB_TRACE_TIMEOUT_MS = 65_000

type DialogSelectorArgs = GitLabDialogRepoSelector & { repoPath: string }

function giteaSelector(args: DialogSelectorArgs): GiteaRepoSelectorArgs {
  return {
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext: args.sourceContext,
    repoOwnerExecutionHostId: args.repoOwnerExecutionHostId
  }
}

/** Adapts the GitLab-shaped dialog calls onto `giteaApiFor`; one instance per open dialog. */
export function createGiteaDialogForge(): GitLabDialogForge {
  const reviewerIds = new GiteaReviewerIds()
  const itemTypes = new Map<number, 'issue' | 'pr'>()
  const apiFor = (selector: GitLabDialogRepoSelector): ReturnType<GitLabDialogForge['apiFor']> => {
    const gitea = (): GiteaApi => giteaApiFor(selector)
    return {
      workItemDetails: async (args) => {
        const type = args.type === 'mr' ? 'pr' : 'issue'
        const details = await gitea().workItemDetails({
          ...giteaSelector(args),
          number: args.iid,
          type,
          includeReviewDetails: type === 'pr'
        })
        if (!details) {
          return null
        }
        itemTypes.set(args.iid, type)
        return giteaDetailsToDialogDetails(details, args.repoId ?? '', reviewerIds)
      },
      listLabels: (args) => gitea().listLabels(giteaSelector(args)),
      listAssignableUsers: async (args) =>
        (await gitea().listAssignableUsers(giteaSelector(args))).map((user) =>
          reviewerIds.toDialogUser(user)
        ),
      updateMR: ({ iid, updates, ...args }) =>
        itemTypes.get(iid) === 'issue'
          ? gitea().updateIssue({
              ...giteaSelector(args),
              number: iid,
              updates: {
                title: updates.title,
                body: updates.body,
                addLabels: updates.addLabels,
                removeLabels: updates.removeLabels
              }
            })
          : gitea().updatePR({
              ...giteaSelector(args),
              number: iid,
              updates: {
                title: updates.title,
                body: updates.body,
                addLabels: updates.addLabels,
                removeLabels: updates.removeLabels
              }
            }),
      updateMRReviewers: async ({ iid, reviewerIds: ids, ...args }) => {
        const reviewerUsernames = ids.flatMap((id) => reviewerIds.usernameFor(id) ?? [])
        const result = await gitea().updatePRReviewers({
          ...giteaSelector(args),
          number: iid,
          reviewerUsernames
        })
        return result.ok
          ? {
              ok: true,
              reviewers: result.reviewers.map((username) =>
                reviewerIds.toDialogUser({ username, name: null, avatarUrl: '' })
              )
            }
          : result
      },
      closeMR: ({ iid, ...args }) => gitea().closePR({ ...giteaSelector(args), number: iid }),
      reopenMR: ({ iid, ...args }) => gitea().reopenPR({ ...giteaSelector(args), number: iid }),
      mergeMR: ({ iid, ...args }) =>
        gitea().mergePR({ ...giteaSelector(args), number: iid, method: 'merge' }),
      addMRComment: ({ iid, body, ...args }) =>
        gitea().addPRComment({ ...giteaSelector(args), number: iid, body }),
      addIssueComment: ({ number, body, ...args }) =>
        gitea().addIssueComment({ ...giteaSelector(args), number, body }),
      addMRInlineComment: ({ iid, input, ...args }) =>
        gitea().addPRInlineComment({
          ...giteaSelector(args),
          number: iid,
          input: { body: input.body, path: input.path, line: input.line, headSha: input.headSha }
        }),
      resolveMRDiscussion: ({ iid, discussionId, resolved, ...args }) =>
        gitea().resolvePRDiscussion({
          ...giteaSelector(args),
          number: iid,
          discussionId,
          resolved
        }),
      jobTrace: ({ jobId, logExcerpt, ...args }) =>
        withGitLabIpcTimeout(
          gitea().jobTrace({ ...giteaSelector(args), jobId, projectRef: null, logExcerpt }),
          {
            timeoutMs: GITEA_JOB_TRACE_TIMEOUT_MS,
            message: translate(
              'auto.runtime.giteaJobTraceClient.timedOut',
              'Timed out loading the Gitea job log.'
            )
          }
        ),
      // Why: Gitea Actions exposes no per-job rerun endpoint; the Retry control is hidden for this forge.
      retryJob: () =>
        Promise.resolve({
          ok: false,
          error: translate(
            'auto.components.GiteaItemDialog.retryUnsupported',
            'Gitea does not support retrying a single job.'
          )
        })
    }
  }
  return { kind: 'gitea', apiFor, canEditIssues: true, canRetryJobs: false }
}

import { gitLabApiFor } from '@/runtime/gitlab-owner-api'
import type { GitLabApi } from '../../../../preload/api/gitlab-api'
import type { GitLabDialogRepoSelector } from './gitlab-item-dialog-types'

export type GitLabDialogApi = Pick<
  GitLabApi,
  | 'addIssueComment'
  | 'addMRComment'
  | 'addMRInlineComment'
  | 'closeMR'
  | 'jobTrace'
  | 'listAssignableUsers'
  | 'listLabels'
  | 'mergeMR'
  | 'reopenMR'
  | 'resolveMRDiscussion'
  | 'retryJob'
  | 'updateMR'
  | 'updateMRReviewers'
  | 'workItemDetails'
>

/** Forge-specific wiring the shared GitLab-shaped work-item dialog runs against. */
export type GitLabDialogForge = {
  kind: 'gitlab' | 'gitea'
  apiFor: (selector: GitLabDialogRepoSelector) => GitLabDialogApi
  /** GitLab issues stay read-only here; Gitea issues share the PR edit flow. */
  canEditIssues: boolean
  canRetryJobs: boolean
}

export const GITLAB_DIALOG_FORGE: GitLabDialogForge = {
  kind: 'gitlab',
  apiFor: gitLabApiFor,
  canEditIssues: false,
  canRetryJobs: true
}

export function dialogFeatureInteractionId(
  forge: GitLabDialogForge
): 'gitlab-tasks' | 'gitea-tasks' {
  return forge.kind === 'gitea' ? 'gitea-tasks' : 'gitlab-tasks'
}

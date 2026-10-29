import type { ClassifiedError } from './classified-error'

// One English table for GitHub/GitLab operation failures: main builds the wire `error`, the renderer translates by code.
export const CODE_HOST_FAILURE_COPY = {
  titleRequired: 'Title is required',
  networkError: 'Network error — check your connection.',
  invalidUpdate: 'Invalid update — {{detail}}',
  invalidRequest: 'Invalid request — {{detail}}',
  issueNotFound: 'Issue not found — it may have been deleted.',
  issueUpdateFailed: 'Failed to update issue: {{detail}}',
  'github.repoUnresolved': 'Could not resolve GitHub owner/repo for this repository',
  'github.unexpectedResponse': 'Unexpected response from GitHub',
  'github.pullRequestIdUnresolved': 'Could not resolve GitHub pull request ID',
  'github.reviewerRequired': 'Enter at least one reviewer',
  'github.stackAutoMergeUnsupported':
    'GitHub does not support auto-merge for stacked pull requests.',
  'github.autoMergeAlreadyMergeable':
    'This pull request can already be merged. Use Merge instead of auto-merge.',
  'github.noFailedChecks': 'No failed GitHub Actions checks to rerun.',
  'github.noRerunnableChecks': 'No rerunnable checks found.',
  'github.stackMergeInvalidResponse': 'GitHub returned an invalid stack merge response.',
  'github.stackMergePending': 'GitHub is still merging this stack. Refresh to check its status.',
  'github.rateLimited': 'GitHub rate limit hit. Try again in a few minutes.',
  'github.issuePermissionDenied':
    "You don't have permission to edit this issue. Check your GitHub token scopes.",
  'github.issuesDisabled': 'Issues are disabled on this repository.',
  'github.pullRequestPermissionDenied':
    "You don't have permission to edit this pull request. Check your GitHub token scopes.",
  'github.pullRequestNotFound': 'Pull request not found — it may have been deleted.',
  'github.pullRequestUpdateFailed': 'Failed to update pull request: {{detail}}',
  'github.autoMergeEnableFailed': 'Failed to enable auto-merge for pull request: {{detail}}',
  'github.autoMergeDisableFailed': 'Failed to disable auto-merge for pull request: {{detail}}',
  'github.mergeQueueAddFailed': 'Failed to add pull request to the merge queue: {{detail}}',
  'github.rerunPermissionDenied':
    "You don't have permission to rerun checks on this repository. Check your GitHub token scopes.",
  'github.rerunTargetNotFound':
    'GitHub resource to rerun was not found — it may have expired or been deleted.',
  'github.rerunRejected': 'Could not rerun checks — {{detail}}',
  'github.rerunFailed': 'Failed to rerun checks: {{detail}}',
  'gitlab.projectUnresolved': 'Could not resolve GitLab project for this repository',
  'gitlab.unexpectedResponse': 'Unexpected response from GitLab',
  'gitlab.commentBodyRequired': 'Comment body is required',
  'gitlab.discussionIdRequired': 'Discussion id is required',
  'gitlab.readyTitleConflict': 'Cannot update the title while marking a merge request ready',
  'gitlab.mergeRequestTitleUnreadable': 'Could not read the current merge request title',
  'gitlab.rateLimited': 'GitLab rate limit hit. Try again in a few minutes.',
  'gitlab.issuePermissionDenied':
    "You don't have permission to edit this issue. Check your GitLab token scopes.",
  'gitlab.jobLogPermissionDenied':
    "You don't have permission to read this job's log. Check your GitLab token scopes.",
  'gitlab.jobProjectNotFound': "Could not find this job's GitLab project.",
  'gitlab.jobLogFailed': 'Failed to load the job log: {{detail}}'
} as const

export type CodeHostFailureCode = keyof typeof CODE_HOST_FAILURE_COPY

/** Wire shape: `error` stays English for older clients; `errorDetail` is verbatim gh/glab text. */
export type CodeHostFailure = {
  ok: false
  error: string
  errorCode?: string
  errorDetail?: string
}

export function codeHostFailureText(code: CodeHostFailureCode, detail?: string): string {
  return CODE_HOST_FAILURE_COPY[code].replace('{{detail}}', () => detail ?? '')
}

export function codeHostFailure(code: CodeHostFailureCode, detail?: string): CodeHostFailure {
  return {
    ok: false,
    error: codeHostFailureText(code, detail),
    errorCode: code,
    ...(detail !== undefined ? { errorDetail: detail } : {})
  }
}

export function classifiedCodeHostError(
  type: ClassifiedError['type'],
  code: CodeHostFailureCode,
  detail?: string
): ClassifiedError {
  return {
    type,
    message: codeHostFailureText(code, detail),
    code,
    ...(detail !== undefined ? { detail } : {})
  }
}

/** Carries a classified gh/glab failure onto an `{ ok: false }` result. */
export function classifiedFailure(classified: ClassifiedError): CodeHostFailure {
  return {
    ok: false,
    error: classified.message,
    ...(classified.code !== undefined ? { errorCode: classified.code } : {}),
    ...(classified.detail !== undefined ? { errorDetail: classified.detail } : {})
  }
}

/** A single failure keeps its code; several are joined in English only. */
export function combinedClassifiedFailure(errors: readonly ClassifiedError[]): CodeHostFailure {
  return errors.length === 1
    ? classifiedFailure(errors[0])
    : { ok: false, error: errors.map((e) => e.message).join('; ') }
}

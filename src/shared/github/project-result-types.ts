// Project IPC envelopes share classified failures and cross-module work-item/comment/user types unnecessary in the ProjectV2 domain model.
import type { PRComment } from './comment-types'
import type {
  GitHubIssueType,
  GitHubProjectOwnerType,
  GitHubProjectSummary,
  GitHubProjectTable,
  GitHubProjectViewSummary
} from './project-types'
import type { GitHubAssignableUser } from './pull-request-types'
import type { GitHubWorkItemDetails } from './work-item-types'

export type GitHubProjectViewErrorType =
  | 'auth_required'
  | 'scope_missing'
  | 'not_found'
  | 'unsupported_layout'
  | 'too_large'
  | 'schema_drift'
  | 'validation_error'
  | 'network_error'
  | 'rate_limited'
  | 'unknown'

/** Distinguishes Orca-authored sentences that share one `type`; renderers fall back to `message` for unknown or missing reasons. */
export type GitHubProjectViewErrorReason =
  | 'project_or_view_not_found'
  | 'project_not_found'
  | 'view_not_found'
  | 'owner_not_found'
  | 'item_not_found'
  | 'issue_not_found'
  | 'input_required'
  | 'input_too_large'
  | 'input_unparseable'
  | 'invalid_slug'
  | 'invalid_positive_integer'
  | 'invalid_owner_type'
  | 'invalid_item_type'
  | 'missing_ids'
  | 'updates_required'
  | 'comment_body_required'
  | 'duplicate_target_not_allowed'
  | 'duplicate_target_required'
  | 'request_invalid'
  | 'request_failed'
  | 'unexpected_rest_response'

export type GitHubProjectViewError = {
  type: GitHubProjectViewErrorType
  /** English copy kept for mobile, older clients and logs. */
  message: string
  reason?: GitHubProjectViewErrorReason
  /** GitHub host for sign-in commands. */
  host?: string
  rateLimit?: { remaining: number; limit: number; resetMinutes: number }
  /** Untranslated diagnostic or field name that follows Orca's own prefix. */
  detail?: string
  /** Rejected slug value for `invalid_slug`. */
  value?: string
  /** Classified GraphQL details only; never include tokens or full command stdout. */
  details?: { path?: (string | number)[]; code?: string }
}

export type GetProjectViewTableResult =
  | { ok: true; data: GitHubProjectTable }
  | {
      ok: false
      error: GitHubProjectViewError
      /** Populated for the `too_large` case and best-effort for
       *  `unsupported_layout` when a cheap count-only query succeeds. */
      totalCount?: number
    }

export type ListAccessibleProjectsResult =
  | {
      ok: true
      projects: GitHubProjectSummary[]
      /** Org discovery can partially fail; name failed owners so the picker can show incompleteness and accept pasted URLs for missing projects. */
      partialFailures?: { owner: string; message: string }[]
    }
  | { ok: false; error: GitHubProjectViewError }

export type ResolveProjectRefResult =
  | {
      ok: true
      owner: string
      ownerType: GitHubProjectOwnerType
      number: number
      title: string
      host?: string
      // Parsed /views/{n} lets the picker commit directly; absent for shorthand and plain project URLs.
      viewNumber?: number
    }
  | { ok: false; error: GitHubProjectViewError }

export type ListProjectViewsResult =
  | { ok: true; views: GitHubProjectViewSummary[] }
  | { ok: false; error: GitHubProjectViewError }

export type ProjectWorkItemDetailsBySlugResult =
  | { ok: true; details: GitHubWorkItemDetails }
  | { ok: false; error: GitHubProjectViewError }

export type GitHubProjectMutationResult =
  | { ok: true }
  | { ok: false; error: GitHubProjectViewError }

export type GitHubProjectCommentMutationResult =
  | { ok: true; comment: PRComment }
  | { ok: false; error: GitHubProjectViewError }

export type ListLabelsBySlugResult =
  | { ok: true; labels: string[] }
  | { ok: false; error: GitHubProjectViewError }

export type ListAssignableUsersBySlugResult =
  | { ok: true; users: GitHubAssignableUser[] }
  | { ok: false; error: GitHubProjectViewError }

export type ListReviewTeamsBySlugResult =
  | { ok: true; teams: GitHubAssignableUser[] }
  | { ok: false; error: GitHubProjectViewError }

export type ListIssueTypesBySlugResult =
  | { ok: true; types: GitHubIssueType[] }
  | { ok: false; error: GitHubProjectViewError }

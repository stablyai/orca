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

/** Names the Orca sentence when `type` alone does not; older hosts omit it. */
export type GitHubProjectViewErrorReason =
  | 'project_not_found'
  | 'owner_not_found'
  | 'view_not_found'
  | 'issue_not_found'
  | 'item_not_found'
  | 'project_or_view_not_found'
  | 'rate_limit_hit'
  | 'input_required'
  | 'input_too_large'
  | 'input_unparseable'
  | 'cli_not_authenticated'
  | 'invalid_request'
  | 'request_failed'
  | 'unexpected_rest_response'

export type GitHubProjectViewError = {
  type: GitHubProjectViewErrorType
  /** English copy for mobile, older clients and logs; the desktop renders `type` and `reason` in the UI language. */
  message: string
  reason?: GitHubProjectViewErrorReason
  /** Host named by the sign-in and scope commands. */
  host?: string
  /** Minutes are counted on the host so the copy matches `message` despite clock skew or late rendering. */
  rateLimit?: { remaining: number; limit: number; resetMinutes: number }
  /** Text after the Orca prefix in `message`: GitHub's response or an internal parse failure. */
  diagnostic?: string
  /** Classified GraphQL details only; never include tokens or full command stdout. */
  details?: { path?: (string | number)[]; code?: string }
}

/** An owner whose projects discovery could not list; `owner` is `*` for the organization list itself. */
export type GitHubProjectPartialFailure = {
  owner: string
  message: string
  error?: GitHubProjectViewError
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
      partialFailures?: GitHubProjectPartialFailure[]
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

export type ListIssueTypesBySlugResult =
  | { ok: true; types: GitHubIssueType[] }
  | { ok: false; error: GitHubProjectViewError }

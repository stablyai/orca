// Why: the ok/error envelopes returned by Project IPC calls all share one
// classified error, and they pull in cross-module work-item/comment/user types
// that the ProjectV2 data model in `./project-types` never needs.
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

// ─── Classified errors ─────────────────────────────────────────────────

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

export type GitHubProjectViewError = {
  type: GitHubProjectViewErrorType
  message: string
  /** Populated when the error is classifiable from a GraphQL response. Never
   *  includes tokens or full command stdout. */
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
      /** Why: per-org discovery can partially fail (a single org 504s while
       *  the rest succeed). The picker renders a banner listing the affected
       *  org logins so the user knows their list is incomplete and can paste
       *  a URL to reach missing projects. Empty when discovery was clean. */
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
      // Why: when the input is a /views/{n} URL, surface the parsed view
      // number so the picker can skip the view-pick step and commit the
      // selection directly. Absent for owner/number shorthand and project
      // URLs without a /views/ segment.
      viewNumber?: number
    }
  | { ok: false; error: GitHubProjectViewError }

export type ListProjectViewsResult =
  | { ok: true; views: GitHubProjectViewSummary[] }
  | { ok: false; error: GitHubProjectViewError }

export type ProjectWorkItemDetailsBySlugResult =
  | { ok: true; details: GitHubWorkItemDetails }
  | { ok: false; error: GitHubProjectViewError }

// ─── Mutations ─────────────────────────────────────────────────────────

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

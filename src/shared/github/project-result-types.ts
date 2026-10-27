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

export type GitHubProjectViewError = {
  type: GitHubProjectViewErrorType
  message: string
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

export type ListIssueTypesBySlugResult =
  | { ok: true; types: GitHubIssueType[] }
  | { ok: false; error: GitHubProjectViewError }

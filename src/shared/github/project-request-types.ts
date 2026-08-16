// Why: the request half of the Project IPC contract, consumed mainly by main
// and preload; kept apart from the ProjectV2 data model in `./project-types`
// so renderer components importing domain shapes don't pull in arg payloads.
import type { GitHubProjectFieldMutationValue, GitHubProjectOwnerType } from './project-types'
import type { GitHubIssueUpdate } from '../issue-mutation-types'

// ─── IPC arg shapes (shared between main, preload, renderer) ──────────

export type GetProjectViewTableArgs = {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  /** GitHub host (e.g. GHES); absent means github.com. */
  host?: string
  /** View selection precedence: viewId > viewNumber > viewName > first
   *  TABLE_LAYOUT view. */
  viewId?: string
  viewNumber?: number
  viewName?: string
  /** Ephemeral GitHub-search-syntax query that replaces the view's filter for
   *  this fetch only. The view's stored filter on GitHub is not modified.
   *  `undefined` uses the view's saved filter; `''` explicitly clears it for
   *  this fetch and gets a distinct renderer cache key. */
  queryOverride?: string
}

export type ProjectWorkItemDetailsBySlugArgs = {
  owner: string
  repo: string
  host?: string
  number: number
  type: 'issue' | 'pr'
}

export type UpdateProjectItemFieldArgs = {
  projectId: string
  host?: string
  itemId: string
  fieldId: string
  value: GitHubProjectFieldMutationValue
}

export type ClearProjectItemFieldArgs = {
  projectId: string
  host?: string
  itemId: string
  fieldId: string
}

export type UpdateIssueBySlugArgs = {
  owner: string
  repo: string
  host?: string
  number: number
  updates: GitHubIssueUpdate & { body?: string }
}

export type UpdatePullRequestBySlugArgs = {
  owner: string
  repo: string
  host?: string
  number: number
  updates: { title?: string; body?: string; state?: 'open' | 'closed' }
}

export type AddIssueCommentBySlugArgs = {
  owner: string
  repo: string
  host?: string
  number: number
  body: string
}

export type UpdateIssueCommentBySlugArgs = {
  owner: string
  repo: string
  host?: string
  commentId: number
  body: string
}

export type DeleteIssueCommentBySlugArgs = {
  owner: string
  repo: string
  host?: string
  commentId: number
}

export type ListLabelsBySlugArgs = {
  owner: string
  repo: string
  host?: string
}

export type ListAssignableUsersBySlugArgs = {
  owner: string
  repo: string
  host?: string
  seedLogins?: string[]
}

export type ListIssueTypesBySlugArgs = {
  owner: string
  repo: string
  host?: string
}

export type UpdateIssueTypeBySlugArgs = {
  owner: string
  repo: string
  host?: string
  number: number
  /** null clears the issue type. */
  issueTypeId: string | null
}

export type ResolveProjectRefArgs = {
  input: string
  host?: string
}

export type ListProjectViewsArgs = {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  host?: string
}

export type ListAccessibleProjectsArgs = {
  /** GitHub host (e.g. GHES); absent means github.com. */
  host?: string
}

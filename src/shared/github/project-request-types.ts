// Keep Project request payloads separate from ProjectV2 domain shapes so renderer domain imports do not pull IPC arguments.
import type { GitHubProjectFieldMutationValue, GitHubProjectOwnerType } from './project-types'
import type { GitHubIssueUpdate } from '../issue-mutation-types'

export type GetProjectViewTableArgs = {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  /** GitHub host (e.g. GHES); absent means github.com. */
  host?: string
  /** View selection: viewId > viewNumber > viewName > first TABLE_LAYOUT. */
  viewId?: string
  viewNumber?: number
  viewName?: string
  /** Fetch-only GitHub search override; never mutates the saved view filter. Undefined uses the saved filter, while empty clears it and has a distinct cache key. */
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

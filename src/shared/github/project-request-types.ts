// Keep Project request payloads separate from ProjectV2 domain shapes so renderer domain imports do not pull IPC arguments.
import type { GitHubProjectFieldMutationValue, GitHubProjectOwnerType } from './project-types'
import type { GitHubIssueUpdate } from '../issue-mutation-types'

/** Set by a click: it may start the stopped WSL distro gh lives in (E9). Loads that also run
 * unprompted (mount effects, restore) leave it unset. Local IPC only. */
export type WakeWslDistroArg = { wakeWslDistro?: boolean }

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

export type ProjectWorkItemDetailsBySlugArgs = WakeWslDistroArg & {
  owner: string
  repo: string
  host?: string
  number: number
  type: 'issue' | 'pr'
}

export type UpdateProjectItemFieldArgs = WakeWslDistroArg & {
  projectId: string
  host?: string
  itemId: string
  fieldId: string
  value: GitHubProjectFieldMutationValue
}

export type ClearProjectItemFieldArgs = WakeWslDistroArg & {
  projectId: string
  host?: string
  itemId: string
  fieldId: string
}

export type UpdateIssueBySlugArgs = WakeWslDistroArg & {
  owner: string
  repo: string
  host?: string
  number: number
  updates: GitHubIssueUpdate & { body?: string }
}

export type UpdatePullRequestBySlugArgs = WakeWslDistroArg & {
  owner: string
  repo: string
  host?: string
  number: number
  updates: { title?: string; body?: string; state?: 'open' | 'closed' }
}

export type AddIssueCommentBySlugArgs = WakeWslDistroArg & {
  owner: string
  repo: string
  host?: string
  number: number
  body: string
}

export type UpdateIssueCommentBySlugArgs = WakeWslDistroArg & {
  owner: string
  repo: string
  host?: string
  commentId: number
  body: string
}

export type DeleteIssueCommentBySlugArgs = WakeWslDistroArg & {
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

export type ListReviewTeamsBySlugArgs = {
  owner: string
  repo: string
  host?: string
}

export type ListIssueTypesBySlugArgs = {
  owner: string
  repo: string
  host?: string
}

export type UpdateIssueTypeBySlugArgs = WakeWslDistroArg & {
  owner: string
  repo: string
  host?: string
  number: number
  /** null clears the issue type. */
  issueTypeId: string | null
}

export type ResolveProjectRefArgs = WakeWslDistroArg & {
  input: string
  host?: string
}

export type ListProjectViewsArgs = WakeWslDistroArg & {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
  host?: string
}

export type ListAccessibleProjectsArgs = WakeWslDistroArg & {
  /** GitHub host (e.g. GHES); absent means github.com. */
  host?: string
}

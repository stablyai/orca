/* eslint-disable max-lines -- Why: this module is the single source of truth for ProjectV2 shapes (settings, IPC payloads, view/field/value types) shared across main, preload, and renderer; splitting risks circular type imports. */
// Why: ProjectV2 shapes are distinct enough from the issue/PR work-item types
// that we keep them in a dedicated module. Preload and main-process callers
// import from here directly — do not re-export through `./types.ts` just to
// match the existing import block; routing through the issue types module
// would obscure ownership of the Project surface.
import type {
  GitHubAssignableUser,
  GitHubIssueUpdate,
  GitHubWorkItemDetails,
  PRComment
} from './types'

export type GitHubProjectViewLayout = 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'
export type GitHubProjectOwnerType = 'organization' | 'user'

// Why: anything outside this union must render as an empty cell — the
// normalizer must never throw on an unknown dataType. The `(string & {})`
// branch preserves unknown values verbatim for debuggability while still
// satisfying the distinct field-kind discriminants below.
export type GitHubProjectFieldDataType =
  | 'TITLE'
  | 'ASSIGNEES'
  | 'LABELS'
  | 'LINKED_PULL_REQUESTS'
  | 'REVIEWERS'
  | 'REPOSITORY'
  | 'MILESTONE'
  | 'PARENT_ISSUE'
  | 'SUB_ISSUES_PROGRESS'
  | 'TRACKS'
  | 'TRACKED_BY'
  | 'ISSUE_TYPE'
  | 'TEXT'
  | 'NUMBER'
  | 'DATE'
  | 'SINGLE_SELECT'
  | 'ITERATION'

export type GitHubProjectSingleSelectOption = {
  id: string
  name: string
  color: string
}

export type GitHubProjectIteration = {
  id: string
  title: string
  /** YYYY-MM-DD — GitHub returns a calendar date, not an ISO timestamp. */
  startDate: string
  /** Length in days. */
  duration: number
  /** True when GitHub returned this iteration under `completedIterations`. */
  completed: boolean
}

export type GitHubProjectField =
  | {
      kind: 'field'
      id: string
      name: string
      dataType: Exclude<GitHubProjectFieldDataType, 'SINGLE_SELECT' | 'ITERATION'> | (string & {})
    }
  | {
      kind: 'single-select'
      id: string
      name: string
      dataType: 'SINGLE_SELECT'
      options: GitHubProjectSingleSelectOption[]
    }
  | {
      kind: 'iteration'
      id: string
      name: string
      dataType: 'ITERATION'
      iterations: GitHubProjectIteration[]
    }

export type GitHubProjectSortDirection = 'ASC' | 'DESC'

export type GitHubProjectSort = {
  direction: GitHubProjectSortDirection
  field: GitHubProjectField
}

export type GitHubProjectView = {
  id: string
  number: number
  name: string
  layout: GitHubProjectViewLayout
  /** Normalized to '' when GitHub returns null. Why: passing null through as
   *  `$q` in the items query would change the query shape between filtered
   *  and unfiltered views; the empty string keeps the GraphQL shape stable. */
  filter: string
  fields: GitHubProjectField[]
  groupByFields: GitHubProjectField[]
  sortByFields: GitHubProjectSort[]
}

export type GitHubProjectUser = {
  login: string
  name: string | null
  avatarUrl: string | null
}

export type GitHubProjectLabel = {
  name: string
  color: string
}

export type GitHubProjectParentIssue = {
  number: number
  title: string
  url: string
}

// Why: GitHub Issue Types are a repo-level taxonomy (Bug/Feature/Task/etc).
// Only repos opted into typed-issues expose a non-empty list. We carry both
// id and human-readable name so the picker can reflect updates without a
// re-fetch and the cell can render the chosen name with its color.
export type GitHubIssueType = {
  id: string
  name: string
  color: string | null
  description: string | null
}

export type GitHubProjectFieldValue =
  | {
      kind: 'single-select'
      fieldId: string
      optionId: string
      name: string
      color: string
    }
  | {
      kind: 'iteration'
      fieldId: string
      iterationId: string
      title: string
      startDate: string
      duration: number
    }
  | { kind: 'text'; fieldId: string; text: string }
  | { kind: 'number'; fieldId: string; number: number }
  | { kind: 'date'; fieldId: string; date: string }
  | { kind: 'labels'; fieldId: string; labels: GitHubProjectLabel[] }
  | { kind: 'users'; fieldId: string; users: GitHubProjectUser[] }

export type GitHubProjectRowItemType = 'ISSUE' | 'PULL_REQUEST' | 'DRAFT_ISSUE' | 'REDACTED'

export type GitHubProjectRow = {
  id: string
  itemType: GitHubProjectRowItemType
  content: {
    number: number | null
    title: string
    /** DraftIssue body and optional detail-cache patch target; list rows do
     *  not render issue/PR body. */
    body: string | null
    url: string | null
    state: string | null
    /** Issue stateReason; null for PR/draft. Why: closed-as-not-planned needs
     *  a different glyph than a regular closed issue. */
    stateReason: string | null
    /** PullRequest.isDraft; null otherwise. */
    isDraft: boolean | null
    /** nameWithOwner, e.g. 'stablyai/orca'. */
    repository: string | null
    assignees: GitHubProjectUser[]
    labels: GitHubProjectLabel[]
    parentIssue: GitHubProjectParentIssue | null
    /** Issue.issueType when set; null on PRs/drafts/redacted or when unset. */
    issueType: GitHubIssueType | null
  }
  fieldValuesByFieldId: Record<string, GitHubProjectFieldValue>
  updatedAt: string
  /** Original fetched order (zero-based index in the fully paginated
   *  POSITION ASC stream). Used as the final tie-break so equal sort values
   *  keep GitHub rank order. */
  position: number
}

export type GitHubProjectTable = {
  project: {
    id: string
    owner: string
    ownerType: GitHubProjectOwnerType
    number: number
    title: string
    url: string
  }
  selectedView: GitHubProjectView
  rows: GitHubProjectRow[]
  /** Echoes ProjectV2.items.totalCount for the view filter. */
  totalCount: number
  /** True when the `parent` retry fallback fired. The UI can hint
   *  "sub-issues unavailable" without claiming a hard error. */
  parentFieldDropped: boolean
}

export type GitHubProjectSummary = {
  id: string
  owner: string
  ownerType: GitHubProjectOwnerType
  number: number
  title: string
  url: string
  source: 'viewer' | `org:${string}`
}

export type GitHubProjectViewSummary = {
  id: string
  number: number
  name: string
  layout: GitHubProjectViewLayout
}

export type GitHubProjectSettings = {
  pinned: { owner: string; ownerType: GitHubProjectOwnerType; number: number }[]
  recent: {
    owner: string
    ownerType: GitHubProjectOwnerType
    number: number
    lastOpenedAt: string
  }[]
  lastViewByProject: Record<string, { viewId: string }>
  activeProject: { owner: string; ownerType: GitHubProjectOwnerType; number: number } | null
}

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

export type GitHubProjectFieldMutationValue =
  | { kind: 'single-select'; optionId: string }
  | { kind: 'iteration'; iterationId: string }
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  /** YYYY-MM-DD. */
  | { kind: 'date'; date: string }

export type ListLabelsBySlugResult =
  | { ok: true; labels: string[] }
  | { ok: false; error: GitHubProjectViewError }

export type ListAssignableUsersBySlugResult =
  | { ok: true; users: GitHubAssignableUser[] }
  | { ok: false; error: GitHubProjectViewError }

export type ListIssueTypesBySlugResult =
  | { ok: true; types: GitHubIssueType[] }
  | { ok: false; error: GitHubProjectViewError }

// ─── IPC arg shapes (shared between main, preload, renderer) ──────────

export type GetProjectViewTableArgs = {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
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
  number: number
  type: 'issue' | 'pr'
}

export type UpdateProjectItemFieldArgs = {
  projectId: string
  itemId: string
  fieldId: string
  value: GitHubProjectFieldMutationValue
}

export type ClearProjectItemFieldArgs = {
  projectId: string
  itemId: string
  fieldId: string
}

export type UpdateIssueBySlugArgs = {
  owner: string
  repo: string
  number: number
  updates: GitHubIssueUpdate & { body?: string }
}

export type UpdatePullRequestBySlugArgs = {
  owner: string
  repo: string
  number: number
  updates: { title?: string; body?: string }
}

export type AddIssueCommentBySlugArgs = {
  owner: string
  repo: string
  number: number
  body: string
}

export type UpdateIssueCommentBySlugArgs = {
  owner: string
  repo: string
  commentId: number
  body: string
}

export type DeleteIssueCommentBySlugArgs = {
  owner: string
  repo: string
  commentId: number
}

export type ListLabelsBySlugArgs = {
  owner: string
  repo: string
}

export type ListAssignableUsersBySlugArgs = {
  owner: string
  repo: string
  seedLogins?: string[]
}

export type ListIssueTypesBySlugArgs = {
  owner: string
  repo: string
}

export type UpdateIssueTypeBySlugArgs = {
  owner: string
  repo: string
  number: number
  /** null clears the issue type. */
  issueTypeId: string | null
}

export type ResolveProjectRefArgs = {
  input: string
}

export type ListProjectViewsArgs = {
  owner: string
  ownerType: GitHubProjectOwnerType
  projectNumber: number
}

// Why: ProjectV2 shapes are distinct enough from the issue/PR work-item types
// that we keep them in a dedicated module. Preload and main-process callers
// import from here directly — do not re-export through `./types.ts` just to
// match the existing import block; routing through the issue types module
// would obscure ownership of the Project surface.

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
    host?: string
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
  host?: string
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
  pinned: { owner: string; ownerType: GitHubProjectOwnerType; number: number; host?: string }[]
  recent: {
    owner: string
    ownerType: GitHubProjectOwnerType
    number: number
    host?: string
    lastOpenedAt: string
  }[]
  lastViewByProject: Record<string, { viewId: string }>
  activeProject: {
    owner: string
    ownerType: GitHubProjectOwnerType
    number: number
    host?: string
  } | null
}

export type GitHubProjectFieldMutationValue =
  | { kind: 'single-select'; optionId: string }
  | { kind: 'iteration'; iterationId: string }
  | { kind: 'text'; text: string }
  | { kind: 'number'; number: number }
  /** YYYY-MM-DD. */
  | { kind: 'date'; date: string }

// Import ProjectV2 shapes directly; re-exporting through issue/PR types.ts obscures Project ownership.

export type GitHubProjectViewLayout = 'TABLE_LAYOUT' | 'BOARD_LAYOUT' | 'ROADMAP_LAYOUT'

/** One layout allowlist serves host/tab/picker gates; unchecked raw.layout must reject unknown future values consistently. */
export function isRenderableProjectViewLayout(layout: string): boolean {
  return layout === 'TABLE_LAYOUT' || layout === 'BOARD_LAYOUT' || layout === 'ROADMAP_LAYOUT'
}
export type GitHubProjectOwnerType = 'organization' | 'user'

// Unknown data types render empty, never throw; string & {} preserves unknown wire values while retaining known discriminants.
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
  /** Null normalizes to empty: ProjectV2.items(query:) defaults to empty, equivalent to omitting query. Empty signals unfiltered UI; no separate non-search field exists. */
  filter: string
  fields: GitHubProjectField[]
  groupByFields: GitHubProjectField[]
  sortByFields: GitHubProjectSort[]
  /** Optional for older hosts/GHES schemas lacking verticalGroupByFields. */
  verticalGroupByFields?: GitHubProjectField[]
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

// Opted-in repos expose Issue Types; carry id/name/color so pickers and cells reflect changes without refetching.
export type GitHubIssueType = {
  id: string
  name: string
  color: string | null
  description: string | null
}

export type GitHubProjectLinkedPullRequests = {
  pullRequests: { number: number; title: string; url: string }[]
  totalCount: number
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
      /** Owning field label for fields hidden in view config; older hosts omit it. */
      fieldName?: string
    }
  | { kind: 'text'; fieldId: string; text: string }
  | { kind: 'number'; fieldId: string; number: number }
  | { kind: 'date'; fieldId: string; date: string; fieldName?: string }
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
    /** Issue-only stateReason distinguishes closed-as-not-planned glyphs; null for PRs/drafts. */
    stateReason: string | null
    /** PullRequest.isDraft; null otherwise. */
    isDraft: boolean | null
    /** nameWithOwner, e.g. 'stablyai/orca'. */
    repository: string | null
    assignees: GitHubProjectUser[]
    labels: GitHubProjectLabel[]
    parentIssue: GitHubProjectParentIssue | null
    linkedPullRequests?: GitHubProjectLinkedPullRequests | null
    /** Present when the ProjectV2Item content is an Issue and GitHub returned its summary. */
    subIssuesProgress?: { completed: number; total: number; percentCompleted: number } | null
    /** Issue.issueType when set; null on PRs/drafts/redacted or when unset. */
    issueType: GitHubIssueType | null
  }
  fieldValuesByFieldId: Record<string, GitHubProjectFieldValue>
  updatedAt: string
  /** Zero-based fully paginated POSITION ASC order; final tie-break preserves GitHub rank. */
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
  /** True after parent-field fallback; permits a sub-issues-unavailable hint without a hard error. */
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

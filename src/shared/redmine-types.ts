// Shared Redmine provider types.
//
// Redmine is a self-hosted issue tracker with no git remote, so it plugs into
// Orca as an account-level TaskProvider (like Jira), not a per-repo source.
// Everything the renderer needs to render the issue list + detail crosses IPC/
// RPC, so these types must stay serialization-friendly (plain objects only).

export type RedmineSite = {
  id: string
  siteUrl: string
  displayName: string
  /** True when an encrypted API key exists on disk for this site. */
  hasToken: boolean
}

export type RedmineSiteId = string

export type RedmineSiteSelection = RedmineSiteId | 'all'

export type RedmineUser = {
  id: number
  name: string
  login: string | null
  avatarUrl?: string | null
}

export type RedmineProject = {
  id: number
  /** Only present in project-list payloads; issue payloads carry just id+name. */
  identifier?: string
  name: string
}

export type RedmineTracker = {
  id: number
  name: string
}

export type RedmineIssueStatus = {
  id: number
  name: string
  isClosed?: boolean
}

export type RedminePriority = {
  id: number
  name: string
}

export type RedmineCustomField = {
  id: number
  name: string
  value: string | number | object | null
}

export type RedmineIssue = {
  id: number
  subject: string
  project: RedmineProject
  tracker: RedmineTracker
  status: RedmineIssueStatus
  priority: RedminePriority
  author: RedmineUser
  assignedTo: RedmineUser | null
  description: string | null
  startDate: string | null
  dueDate: string | null
  doneRatio: number
  estimatedHours: number | null
  spentHours: number | null
  createdOn: string
  updatedOn: string
  closedOn: string | null
  customFields: RedmineCustomField[]
  url: string
}

export type RedmineConnectionErrorType = 'auth' | 'decryption' | 'network' | 'unknown'

export type RedmineConnectionError = {
  type: RedmineConnectionErrorType
  message: string
}

export type RedmineConnectionStatus = {
  connected: boolean
  activeSite: RedmineSite | null
  selectedSiteId: RedmineSiteSelection | null
  viewer: RedmineUser | null
  error: RedmineConnectionError | null
}

export type RedmineReadErrorType = 'auth' | 'network' | 'not_found' | 'unknown'

export type RedmineReadError = {
  type: RedmineReadErrorType
  message: string
  status?: number | null
}

export type RedmineIssueCollectionResult = {
  items: RedmineIssue[]
  totalCount: number
  error?: RedmineReadError
}

/** Mirrors Redmine's `status_id=open` / `closed` / `all` query states. */
export type RedmineIssueListState = 'open' | 'closed' | 'all'

/** Which issues to list: mine vs created-by-me vs every issue on the server. */
export type RedmineIssueListScope = 'assigned' | 'created' | 'all'

export type RedmineListFilter = {
  state?: RedmineIssueListState
  scope?: RedmineIssueListScope
  limit?: number
  page?: number
}

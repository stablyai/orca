import type { SecretAtRestProtection } from '../secret-at-rest-protection'
// 'cloud' = Atlassian Cloud (email + API token, Basic auth, REST v3).
// 'server' = self-hosted Jira Server/Data Center (personal access token,
// Bearer auth, REST v2). Older stored sites omit the field and mean 'cloud'.
export type JiraAuthType = 'cloud' | 'server'

export type JiraSite = {
  id: string
  siteUrl: string
  email: string
  displayName: string
  accountId: string
  authType?: JiraAuthType
  // REST gateway for scoped Cloud tokens; siteUrl remains the browse-link origin.
  apiBaseUrl?: string
}

export type JiraViewer = {
  accountId: string
  displayName: string
  email: string | null
  avatarUrl?: string
}

export type JiraSiteSelection = (string & {}) | 'all'

export type JiraConnectionStatus = {
  connected: boolean
  viewer: JiraViewer | null
  sites?: JiraSite[]
  activeSiteId?: string | null
  selectedSiteId?: JiraSiteSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
  // 'plaintext' when any stored token is unsealed, so Settings can warn. Optional:
  // an older remote host omits it, and absent must read as "unknown", not "sealed".
  credentialProtection?: SecretAtRestProtection | null
  // Absent on older remote hosts, which require a Cloud email and unscoped token.
  supportsScopedTokens?: boolean
}

export type JiraProject = {
  id: string
  key: string
  name: string
  siteId?: string
  siteName?: string
}

export type JiraIssueType = {
  id: string
  name: string
  description?: string
  iconUrl?: string
  subtask?: boolean
}

export type JiraCreateFieldAllowedValue = {
  id?: string
  value?: string
  name?: string
}

export type JiraCreateField = {
  key: string
  name: string
  required: boolean
  schema?: {
    type?: string
    items?: string
    custom?: string
    system?: string
  }
  allowedValues?: JiraCreateFieldAllowedValue[]
}

export type JiraUser = {
  accountId: string
  displayName: string
  email?: string | null
  avatarUrl?: string
}

export type JiraPriority = {
  id: string
  name: string
  iconUrl?: string
}

export type JiraStatus = {
  id: string
  name: string
  categoryKey: string
  categoryName: string
  colorName?: string
}

export type JiraProjectStatusOrder = {
  statusIdsByColumn: string[][]
  columns?: { name: string; statusIds: string[] }[]
}

export type JiraTransition = {
  id: string
  name: string
  to: JiraStatus
  fields?: JiraCreateField[]
}

export type JiraIssue = {
  id: string
  key: string
  siteId?: string
  siteName?: string
  title: string
  description?: string
  url: string
  project: JiraProject
  issueType: JiraIssueType
  status: JiraStatus
  labels: string[]
  assignee?: JiraUser
  reporter?: JiraUser
  priority?: JiraPriority
  /** Parent issue (epic for stories, parent story for subtasks). */
  parent?: { key: string; title: string; issueTypeName?: string }
  sprint?: string
  storyPoints?: number
  originalEstimateSeconds?: number
  remainingEstimateSeconds?: number
  updatedAt: string
  createdAt: string
}

export type JiraComment = {
  id: string
  body: string
  createdAt: string
  updatedAt?: string
  user?: JiraUser
}

export type JiraIssueUpdate = {
  labelOperations?: { add?: string[]; remove?: string[] }
  title?: string
  labels?: string[]
  assigneeAccountId?: string | null
  priorityId?: string | null
  transitionId?: string
  transitionFields?: Record<string, unknown>
  transitionComment?: string
  // Edit-screen values keyed by Jira field id. Older remote hosts drop these
  // silently, so clients gate them on JIRA_ISSUE_EDIT_FIELDS_RUNTIME_CAPABILITY.
  fields?: Record<string, unknown>
  // Keys in `fields` the host shapes into {accountId} / {name} references.
  userFieldKeys?: string[]
  // Keys in `fields` holding Markdown (Cloud) or wiki text (Server/DC).
  richTextFieldKeys?: string[]
}

export type JiraEditFieldValue =
  | { kind: 'empty' }
  | { kind: 'text'; text: string }
  | { kind: 'options'; options: JiraCreateFieldAllowedValue[] }
  | { kind: 'users'; users: JiraUser[] }
  | { kind: 'strings'; values: string[] }
  | { kind: 'unsupported'; display: string }

/** An edit-screen field with its current value, from Jira's editmeta. */
export type JiraEditField = JiraCreateField & {
  operations: string[]
  value: JiraEditFieldValue
  richText?: boolean
  // False when Jira refuses `set` or the value cannot be written back intact.
  writable: boolean
  // Jira's own value (ADF on Cloud), null when unset; only on includeRaw reads.
  rawValue?: unknown
}

export type JiraIssueFilter = 'assigned' | 'reported' | 'all' | 'done'
export type JiraIssueListFilters = { statuses?: string[]; currentSprint?: boolean }

export type JiraConnectArgs = {
  siteUrl: string
  // Empty for Bearer authentication: self-hosted PAT or scoped Cloud token.
  email: string
  apiToken: string
  authType?: JiraAuthType
}

export type JiraCreateIssueArgs = {
  siteId?: string
  projectId: string
  issueTypeId: string
  title: string
  description?: string
  customFields?: Record<string, unknown>
  // Keys in customFields holding user ids; the host shapes them into the
  // {accountId} / {name} object Jira requires. Omitted by older clients.
  userFieldKeys?: string[]
}

export type JiraCreateIssueResult =
  | { ok: true; id: string; key: string; url: string }
  | { ok: false; error: string }

export type JiraMutationResult = { ok: true } | { ok: false; error: string }

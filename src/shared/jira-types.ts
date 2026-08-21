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
}

export type JiraTransition = {
  id: string
  name: string
  to: JiraStatus
  /** Present when listTransitions requested expand=transitions.fields. */
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
  title?: string
  labels?: string[]
  assigneeAccountId?: string | null
  priorityId?: string | null
  transitionId?: string
  /** Values for transition-required fields (e.g. resolution: { id }). */
  transitionFields?: Record<string, unknown>
  /** Comment attached to the transition via update.comment. */
  transitionComment?: string
}

export type JiraIssueFilter = 'assigned' | 'reported' | 'all' | 'done'

export type JiraConnectArgs = {
  siteUrl: string
  // Ignored for 'server' auth: self-hosted PATs authenticate via Bearer
  // header alone, so the email field may be empty.
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
}

export type JiraCreateIssueResult =
  | { ok: true; id: string; key: string; url: string }
  | { ok: false; error: string }

export type JiraMutationResult = { ok: true } | { ok: false; error: string }

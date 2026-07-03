// Cloud uses Atlassian-hosted REST v3 + ADF bodies + accountId identities;
// Data Center / Server is self-hosted REST v2 + wiki-markup string bodies and
// username/key identities. The deployment tag selects that behavior per site.
export type JiraDeployment = 'cloud' | 'datacenter'

// Cloud authenticates with email + API token via Basic; Data Center uses a
// Personal Access Token via Bearer (Jira 8.14+) or username + password Basic.
export type JiraAuthScheme = 'basic' | 'bearer'

export type JiraSite = {
  id: string
  siteUrl: string
  email: string
  displayName: string
  accountId: string
  deployment: JiraDeployment
  authScheme: JiraAuthScheme
  // Data Center identities key off username rather than accountId; retained so
  // assignee writes and viewer mapping can address users on self-hosted Jira.
  username?: string
}

export type JiraViewer = {
  accountId: string
  displayName: string
  email: string | null
  avatarUrl?: string
}

export type JiraSiteSelection = string | 'all'

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
  }
  allowedValues?: JiraCreateFieldAllowedValue[]
}

export type JiraUser = {
  accountId: string
  displayName: string
  email?: string | null
  avatarUrl?: string
  // Data Center identifies users by username (and sometimes key) instead of
  // accountId; kept so assignee writes can address the right field per deployment.
  name?: string
  key?: string
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

export type JiraTransition = {
  id: string
  name: string
  to: JiraStatus
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
  // Data Center addresses assignees by username; carried alongside accountId so
  // the client can pick the right field for the deployment.
  assigneeName?: string | null
  priorityId?: string | null
  transitionId?: string
}

export type JiraIssueFilter = 'assigned' | 'reported' | 'all' | 'done'

export type JiraConnectArgs = {
  siteUrl: string
  // Cloud: Atlassian account email. Data Center: optional, only used for
  // username/password Basic auth; ignored when a PAT (Bearer) is supplied.
  email: string
  apiToken: string
  deployment?: JiraDeployment
  // Data Center only. When set, username/password Basic is used; otherwise the
  // token is treated as a Personal Access Token sent via Bearer.
  username?: string
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

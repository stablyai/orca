export type JiraDeploymentType = 'cloud' | 'server'
export type JiraAuthMode = 'basic' | 'bearer'

export type JiraSite = {
  id: string
  siteUrl: string
  email: string
  displayName: string
  accountId: string
  viewerUserId: string
  deploymentType: JiraDeploymentType
  authMode: JiraAuthMode
  authUsername?: string
}

export type JiraViewer = {
  userId: string
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
  // userId is deployment-specific; accountId remains as a deprecated
  // Cloud-era alias for legacy renderer callers.
  userId: string
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
  // assigneeUserId is the renderer-facing field; assigneeAccountId remains
  // as a deprecated Cloud-era alias for existing callers.
  assigneeUserId?: string | null
  assigneeAccountId?: string | null
  priorityId?: string | null
  transitionId?: string
}

export type JiraIssueUpdateStep = 'fields' | 'assignee' | 'transition'

export type JiraIssueFilter = 'assigned' | 'reported' | 'all' | 'done'

export type JiraCloudConnectArgs = {
  // Optional for legacy callers that predate Server/DC support; IPC/RPC/store
  // boundaries normalize omitted deploymentType to Cloud.
  deploymentType?: 'cloud'
  siteUrl: string
  email: string
  apiToken: string
}

export type JiraServerBasicConnectArgs = {
  deploymentType: 'server'
  authMode: 'basic'
  siteUrl: string
  username: string
  passwordOrToken: string
}

export type JiraServerBearerConnectArgs = {
  deploymentType: 'server'
  authMode: 'bearer'
  siteUrl: string
  bearerToken: string
}

export type JiraConnectArgs =
  | JiraCloudConnectArgs
  | JiraServerBasicConnectArgs
  | JiraServerBearerConnectArgs

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

export type JiraMutationResult =
  | { ok: true; applied?: JiraIssueUpdateStep[] }
  | {
      ok: false
      error: string
      applied?: JiraIssueUpdateStep[]
      failedStep?: JiraIssueUpdateStep
    }

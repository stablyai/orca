export type LinearViewer = {
  displayName: string
  email: string | null
  organizationId?: string
  organizationName: string
  organizationUrlKey?: string
}

export type LinearWorkspace = LinearViewer & {
  id: string
  organizationId: string
  isLegacy?: true
  credentialRevision?: number
}

export type LinearWorkspaceSelection = (string & {}) | 'all'
export type LinearWorkspaceSelector = LinearWorkspaceSelection | undefined
export type LinearConcreteWorkspaceId = string

export type LinearWorkspaceError = {
  workspaceId: string
  workspaceName?: string
  type: 'auth' | 'rate_limited' | 'network' | 'unknown'
  message: string
}

export type LinearCollectionResult<T> = {
  items: T[]
  errors?: LinearWorkspaceError[]
  hasMore?: boolean
}

export type LinearConnectionStatus = {
  connected: boolean
  viewer: LinearViewer | null
  workspaces?: LinearWorkspace[]
  activeWorkspaceId?: string | null
  selectedWorkspaceId?: LinearWorkspaceSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
}

export type LinearWorkflowState = {
  id: string
  name: string
  type: string
  color: string
  position: number
}

export type LinearLabel = {
  id: string
  name: string
  color: string
}

export type LinearMember = {
  id: string
  displayName: string
  name?: string
  email?: string
  avatarUrl?: string
}

export type LinearTeam = {
  id: string
  workspaceId?: string
  workspaceName?: string
  name: string
  key: string
  url?: string
}

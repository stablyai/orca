export type PlaneAuthType = 'cloud' | 'self_hosted'

export type PlaneWorkspace = {
  id: string
  name: string
  slug: string
  url: string
  logo?: string
}

export type PlaneViewer = {
  id: string
  displayName: string
  email: string | null
  avatarUrl?: string
  username?: string
}

export type PlaneConnectionStatus = {
  connected: boolean
  viewer: PlaneViewer | null
  instanceUrl?: string | null
  authType?: PlaneAuthType
  workspaces?: PlaneWorkspace[]
  activeWorkspaceSlug?: string | null
  selectedWorkspaceSlug?: string | null
  credentialError?: string
}

export type PlaneProject = {
  id: string
  identifier: string
  name: string
  description?: string
  workspaceSlug: string
}

export type PlaneStateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

export type PlaneState = {
  id: string
  name: string
  group: PlaneStateGroup
  color: string
  sequence: number
}

export type PlaneUser = {
  id: string
  displayName: string
  email?: string | null
  avatarUrl?: string
}

export type PlanePriority = 'none' | 'urgent' | 'high' | 'medium' | 'low'

export type PlaneIssue = {
  id: string
  sequenceId: number
  key: string
  title: string
  description?: string
  url: string
  workspaceSlug: string
  projectId: string
  project: PlaneProject
  state: PlaneState
  priority: PlanePriority
  labels: string[]
  assignees: PlaneUser[]
  createdAt: string
  updatedAt: string
}

export type PlaneComment = {
  id: string
  body: string
  author: PlaneUser
  createdAt: string
}

export type PlaneIssueUpdate = {
  stateId?: string
  priority?: PlanePriority
  title?: string
  description?: string
}

export type PlaneIssueFilter = 'assigned' | 'created' | 'all' | 'done'

export type PlaneConnectArgs = {
  instanceType: PlaneAuthType
  instanceUrl: string
  apiToken: string
}

export type PlaneMutationResult = { ok: true } | { ok: false; error: string }

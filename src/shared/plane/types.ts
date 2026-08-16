export type PlaneInstanceSelection = string | 'all'

export type PlaneViewer = {
  id?: string
  displayName: string
  email?: string | null
}

export type PlaneInstance = {
  id: string
  baseUrl: string
  workspaceSlug: string
  authMode?: 'apiKey' | 'oauth'
  displayName: string
  email?: string | null
  userId?: string | null
  credentialRevision?: number
}

export type PlaneConnectionStatus = {
  connected: boolean
  activeInstanceId: string | null
  selectedInstanceId: PlaneInstanceSelection | null
  instances: PlaneInstance[]
  viewer: PlaneViewer | null
  credentialError?: string | null
}

export type PlaneConnectArgs = {
  baseUrl: string
  workspaceSlug: string
  apiKey: string
}

export type PlaneOAuthConnectArgs = {
  baseUrl: string
  workspaceSlug: string
  clientId: string
  clientSecret: string
  scope?: string
}

export type PlaneProject = {
  id: string
  name: string
  description?: string | null
  identifier?: string | null
  workspaceSlug: string
  instanceId: string
  url?: string | null
  cycleView?: boolean | null
  moduleView?: boolean | null
  inboxView?: boolean | null
  pageView?: boolean | null
  issueViewsView?: boolean | null
  totalCycles?: number | null
  totalModules?: number | null
}

export type PlaneState = {
  id: string
  name: string
  group?: string | null
  color?: string | null
}

export type PlaneLabel = {
  id: string
  name: string
  color?: string | null
}

export type PlaneMember = {
  id: string
  displayName: string
  email?: string | null
}

export type PlaneCycle = {
  id: string
  name: string
  description?: string | null
  startDate?: string | null
  endDate?: string | null
  status?: string | null
  projectId: string
  workspaceSlug: string
  instanceId: string
}

export type PlaneModule = {
  id: string
  name: string
  description?: string | null
  startDate?: string | null
  targetDate?: string | null
  status?: string | null
  lead?: PlaneMember | null
  members?: PlaneMember[]
  projectId: string
  workspaceSlug: string
  instanceId: string
}

export type PlaneWorkItemType = {
  id: string
  name: string
  description?: string | null
  isDefault?: boolean | null
  isActive?: boolean | null
  projectId: string
  workspaceSlug: string
  instanceId: string
}

export type PlaneEstimatePoint = {
  id: string
  key?: string | null
  value?: string | number | null
  description?: string | null
}

export type PlaneEstimate = {
  id: string
  name: string
  description?: string | null
  points?: PlaneEstimatePoint[]
  projectId: string
  workspaceSlug: string
  instanceId: string
}

export type PlaneIssueLink = {
  id: string
  title?: string | null
  url: string
  metadata?: Record<string, unknown> | null
}

export type PlaneIssueAttachment = {
  id: string
  name?: string | null
  url?: string | null
  size?: number | null
  mimeType?: string | null
  createdAt?: string | null
}

export type PlaneEstimatePointValue = string | number

export type PlaneWorkItem = {
  id: string
  identifier: string
  sequenceId?: number | null
  title: string
  description?: string | null
  url: string
  project: Pick<PlaneProject, 'id' | 'name' | 'identifier'>
  state?: PlaneState | null
  assignee?: PlaneMember | null
  assignees?: PlaneMember[]
  assigneeIds?: string[]
  createdBy?: PlaneMember | null
  createdById?: string | null
  labels?: PlaneLabel[]
  labelIds?: string[]
  priority?: string | null
  cycleId?: string | null
  estimatePoint?: PlaneEstimatePointValue | null
  typeId?: string | null
  moduleId?: string | null
  updatedAt?: string | null
  createdAt?: string | null
  workspaceSlug: string
  instanceId: string
}

export type PlaneComment = {
  id: string
  body: string
  createdAt?: string | null
  author?: PlaneMember | null
}

export type PlaneCollectionResult<T> = {
  items: T[]
  hasMore?: boolean
  totalPages?: number
  totalResults?: number
}

export type PlaneIssueUpdate = {
  title?: string
  description?: string | null
  stateId?: string | null
  assigneeIds?: string[]
  labelIds?: string[]
  priority?: string | null
  cycleId?: string | null
  estimatePoint?: PlaneEstimatePointValue | null
  typeId?: string | null
  moduleId?: string | null
}

export type PlaneCreateIssueArgs = {
  projectId: string
  title: string
  description?: string
  stateId?: string
  assigneeIds?: string[]
  labelIds?: string[]
  priority?: string
  cycleId?: string
  estimatePoint?: PlaneEstimatePointValue
  typeId?: string
  moduleId?: string
  externalSource?: string
  externalId?: string
  instanceId?: string
}

export type PlaneListFilter = 'assigned' | 'created' | 'all' | 'completed' | 'open'

export type PlaneStateGroup = 'backlog' | 'unstarted' | 'started' | 'completed' | 'cancelled'

export type PlanePriority = 'urgent' | 'high' | 'medium' | 'low' | 'none'

export type PlaneIssueSort =
  | '-updated_at'
  | 'updated_at'
  | '-created_at'
  | 'created_at'
  | 'priority'
  | '-priority'
  | 'state'
  | '-state'
  | 'name'
  | '-name'
  | 'sort_order'
  | '-sort_order'

export type PlaneIssueQuery = {
  preset?: PlaneListFilter
  query?: string
  projectId?: string
  projectIds?: string[]
  stateGroup?: PlaneStateGroup
  stateGroups?: PlaneStateGroup[]
  stateId?: string
  stateIds?: string[]
  priority?: PlanePriority
  priorities?: PlanePriority[]
  assigneeId?: string | 'unassigned'
  assigneeIds?: string[]
  labelId?: string | 'none'
  labelIds?: string[]
  cycleId?: string | 'none'
  moduleId?: string | 'none'
  typeId?: string
  estimatePoint?: PlaneEstimatePointValue
  orderBy?: PlaneIssueSort
}

// 'cloud' = plane.so (api.plane.so + app.plane.so). 'self-hosted' = a single
// origin serving both the REST API and the web app. Older stored workspaces
// omit the field and mean 'cloud'.
export type PlaneDeployment = 'cloud' | 'self-hosted'

export type PlaneWorkspace = {
  id: string
  slug: string
  name: string
  /** REST root, without the `/api/v1` suffix. */
  baseUrl: string
  /** Web app root, used to build human-facing links. */
  appUrl: string
  deployment?: PlaneDeployment
}

export type PlaneViewer = {
  id: string
  displayName: string
  email: string | null
  avatarUrl?: string
}

export type PlaneWorkspaceSelection = (string & {}) | 'all'

export type PlaneConnectionStatus = {
  connected: boolean
  viewer: PlaneViewer | null
  workspaces?: PlaneWorkspace[]
  activeWorkspaceId?: string | null
  selectedWorkspaceId?: PlaneWorkspaceSelection | null
  // Set when a stored token file exists but could not be decrypted, so the
  // UI can explain reads failing while the connection still looks saved.
  credentialError?: string
}

export type PlaneProject = {
  id: string
  /** Short key shown in work item identifiers, e.g. `PROJ` in `PROJ-123`. */
  identifier: string
  name: string
  workspaceId?: string
  workspaceName?: string
}

export const PLANE_STATE_GROUPS = [
  'backlog',
  'unstarted',
  'started',
  'completed',
  'cancelled'
] as const

export type PlaneStateGroup = (typeof PLANE_STATE_GROUPS)[number]

export type PlaneState = {
  id: string
  name: string
  group: PlaneStateGroup
  color?: string
  /** Plane marks one state per group as the project default. */
  default?: boolean
  sequence?: number
}

export type PlaneLabel = {
  id: string
  name: string
  color?: string
}

export type PlaneMember = {
  id: string
  displayName: string
  email?: string | null
  avatarUrl?: string
}

export const PLANE_PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const

export type PlanePriority = (typeof PLANE_PRIORITIES)[number]

export function isPlanePriority(value: unknown): value is PlanePriority {
  return PLANE_PRIORITIES.includes(value as PlanePriority)
}

export function isPlaneStateGroup(value: unknown): value is PlaneStateGroup {
  return PLANE_STATE_GROUPS.includes(value as PlaneStateGroup)
}

export type PlaneWorkItem = {
  id: string
  /** Human identifier `<project identifier>-<sequence id>`, e.g. `PROJ-123`. */
  key: string
  sequenceId: number
  workspaceId?: string
  workspaceName?: string
  title: string
  description?: string
  url: string
  project: PlaneProject
  state: PlaneState
  labels: PlaneLabel[]
  assignees: PlaneMember[]
  priority: PlanePriority
  startDate?: string | null
  targetDate?: string | null
  createdAt: string
  updatedAt: string
}

// The workspace search endpoint returns a lite projection, not a full work
// item: no state, labels or assignees.
export type PlaneWorkItemSearchResult = {
  id: string
  key: string
  sequenceId: number
  title: string
  projectId: string
  projectIdentifier: string
}

export type PlaneComment = {
  id: string
  body: string
  createdAt: string
  updatedAt?: string
  user?: PlaneMember
}

export type PlaneWorkItemUpdate = {
  title?: string
  stateId?: string
  priority?: PlanePriority
  // Plane replaces the whole set on write; null clears it.
  assigneeIds?: string[] | null
  labelIds?: string[] | null
  targetDate?: string | null
}

export type PlaneWorkItemFilter = 'assigned' | 'created' | 'all' | 'done'

export type PlaneConnectArgs = {
  baseUrl: string
  workspaceSlug: string
  apiToken: string
  /** Defaults to the cloud app root, or to `baseUrl` when self-hosted. */
  appUrl?: string
}

export type PlaneCreateWorkItemArgs = {
  workspaceId?: string
  projectId: string
  title: string
  description?: string
  stateId?: string
  priority?: PlanePriority
  assigneeIds?: string[]
  labelIds?: string[]
}

export type PlaneCreateWorkItemResult =
  | { ok: true; id: string; key: string; url: string }
  | { ok: false; error: string }

export type PlaneMutationResult = { ok: true } | { ok: false; error: string }

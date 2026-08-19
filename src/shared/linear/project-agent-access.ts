import type { LinearErrorCode } from './agent-access'
import type { LinearCollectionMeta, LinearWorkspaceCandidate } from './agent-result-types'

export const LINEAR_PROJECT_UPDATE_HEALTH_API_VALUES = ['onTrack', 'atRisk', 'offTrack'] as const
export type LinearProjectUpdateHealth = (typeof LINEAR_PROJECT_UPDATE_HEALTH_API_VALUES)[number]

export const LINEAR_PROJECT_UPDATES_DEFAULT_LIMIT = 5
export const LINEAR_PROJECT_UPDATES_MAX_LIMIT = 25
export const LINEAR_PROJECT_METADATA_DEFAULT_LIMIT = 20
export const LINEAR_PROJECT_METADATA_MAX_LIMIT = 50
// Why: discovery reads stop scanning here; write resolution pages past it to prove uniqueness.
export const LINEAR_PROJECT_LABEL_SCAN_CAP = 200
export const LINEAR_PROJECT_ENTITY_OUTPUT_CAP = 200

export const LINEAR_PROJECT_STATUS_TYPES = [
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled'
] as const
export type LinearProjectStatusType = (typeof LINEAR_PROJECT_STATUS_TYPES)[number]

/**
 * Complete text plus a digest, then a bounded `value`. `chars` is UTF-16 code
 * units over the complete LF-normalized string and `sha256` is lowercase hex
 * over its UTF-8 bytes, both computed before `value` is capped — so recovery can
 * prove equality without publishing the whole document.
 */
export type LinearBoundedString = {
  value: string
  truncated: boolean
  chars: number
  sha256: string
}

/** A null value hashes as no value (`sha256: ''`), distinct from `''`'s digest. */
export type LinearBoundedNullableString = Omit<LinearBoundedString, 'value'> & {
  value: string | null
}

export type LinearProjectStatusRef = {
  id: string
  name: string
  type: LinearProjectStatusType
  color: string
}

export type LinearProjectLabelRef = {
  id: string
  name: string
  color: string
  parent: { id: string; name: string } | null
}

export type LinearProjectUserRef = {
  id: string
  displayName: string
  avatarUrl: string | null
}

export type LinearProjectTeamRef = { id: string; name: string; key: string }

/**
 * `sha256` covers `JSON.stringify` of every unique id sorted ascending, so a
 * replacement collection stays comparable even when `items` is capped at
 * `LINEAR_PROJECT_ENTITY_OUTPUT_CAP`.
 */
export type LinearBoundedEntityCollection<T extends { id: string }> = {
  items: T[]
  returned: number
  total: number
  truncated: boolean
  sha256: string
}

export type LinearProjectFieldSnapshot = {
  name: string
  description: LinearBoundedString
  content: LinearBoundedNullableString
  status: LinearProjectStatusRef
  lead: LinearProjectUserRef | null
  members: LinearBoundedEntityCollection<LinearProjectUserRef>
  teams: LinearBoundedEntityCollection<LinearProjectTeamRef>
  labels: LinearBoundedEntityCollection<LinearProjectLabelRef>
  priority: number
  startDate: string | null
  targetDate: string | null
  color: string
  icon: string | null
}

export type LinearProjectRef = {
  id: string
  name: string
  slugId: string
  url: string
}

export type LinearProjectTargetRequest = {
  input: string
  workspaceId?: string
}

export type LinearProjectShowRequest = LinearProjectTargetRequest & {
  updates?: boolean
  updatesLimit?: number
}

export type LinearProjectWorkspaceReadRequest = {
  query?: string
  limit?: number
  workspaceId?: (string & {}) | 'all'
}

export type LinearWorkspaceFanoutMeta = {
  query?: string
  workspaceId?: (string & {}) | 'all'
  limit: number
  returned: number
  partial: boolean
  workspaceResults: {
    workspace: LinearWorkspaceCandidate
    returned: number
    hasMore: boolean
  }[]
  workspaceErrors: {
    workspace: LinearWorkspaceCandidate
    code: LinearErrorCode
    message: string
  }[]
}

/** Agent-facing discovery row. Distinct from `./project-types`' app-facing status shape. */
export type LinearProjectStatusSummary = {
  id: string
  name: string
  type: LinearProjectStatusType
  color: string
  workspaceId: string
  workspaceName: string
}

export type LinearProjectLabelSummary = LinearProjectLabelRef & {
  workspaceId: string
  workspaceName: string
}

export type LinearProjectUpdateNode = {
  id: string
  body: LinearBoundedString
  health: LinearProjectUpdateHealth
  url: string
  isDiffHidden: boolean
  isStale: boolean
  createdAt: string
  updatedAt: string
  editedAt: string | null
  user: LinearProjectUserRef
}

export type LinearProjectResolvedBy = 'uuid' | 'slug' | 'url' | 'name'

export type LinearProjectShowResult = {
  project: LinearProjectRef &
    LinearProjectFieldSnapshot & {
      health: LinearProjectUpdateHealth | null
      healthUpdatedAt: string | null
    }
  updates?: LinearProjectUpdateNode[]
  meta: {
    workspaceId: string
    workspaceName: string
    resolvedBy: LinearProjectResolvedBy
    updates?: LinearCollectionMeta
  }
}

export type LinearProjectStatusesResult = {
  statuses: LinearProjectStatusSummary[]
  meta: LinearWorkspaceFanoutMeta
}

export type LinearProjectLabelsResult = {
  labels: LinearProjectLabelSummary[]
  meta: LinearWorkspaceFanoutMeta
}

export function clampLinearProjectUpdatesLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return LINEAR_PROJECT_UPDATES_DEFAULT_LIMIT
  }
  return Math.min(Math.max(1, Math.floor(limit)), LINEAR_PROJECT_UPDATES_MAX_LIMIT)
}

export function clampLinearProjectMetadataLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return LINEAR_PROJECT_METADATA_DEFAULT_LIMIT
  }
  return Math.min(Math.max(1, Math.floor(limit)), LINEAR_PROJECT_METADATA_MAX_LIMIT)
}

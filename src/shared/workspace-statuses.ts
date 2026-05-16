import type { Worktree, WorkspaceStatus, WorkspaceStatusDefinition } from './types'

const WORKSPACE_STATUS_GROUP_PREFIX = 'workspace-status:'
const MAX_STATUS_LABEL_LENGTH = 32
const MAX_WORKSPACE_STATUSES = 12
type WorkspaceStatusNormalizationOptions = {
  migrateLegacyDefaultStatusVisuals?: boolean
}

export const DEFAULT_WORKSPACE_STATUS_ID: WorkspaceStatus = 'in-progress'
export const DEFAULT_WORKSPACE_STATUS_COLOR_ID = 'neutral'
export const DEFAULT_WORKSPACE_STATUS_ICON_ID = 'circle-dot'

export const WORKSPACE_STATUS_COLOR_IDS = [
  'neutral',
  'blue',
  'sky',
  'violet',
  'amber',
  'emerald',
  'rose',
  'zinc',
  'conductor-done',
  'conductor-review',
  'conductor-progress'
] as const

export const WORKSPACE_STATUS_ICON_IDS = [
  'circle',
  'circle-dot',
  'circle-progress',
  'circle-dashed',
  'circle-ellipsis',
  'git-pull-request',
  'timer',
  'flag',
  'circle-alert',
  'circle-pause',
  'circle-play',
  'circle-check',
  'ban',
  'conductor-done',
  'conductor-review',
  'conductor-progress'
] as const

const DEFAULT_STATUS_VISUALS: Record<string, { color: string; icon: string }> = {
  todo: { color: 'neutral', icon: 'circle' },
  'in-progress': { color: 'conductor-progress', icon: 'conductor-progress' },
  'in-review': { color: 'conductor-review', icon: 'conductor-review' },
  completed: { color: 'conductor-done', icon: 'conductor-done' }
}

export const DEFAULT_WORKSPACE_STATUSES = [
  { id: 'todo', label: 'Todo', color: 'neutral', icon: 'circle' },
  {
    id: 'in-progress',
    label: 'In progress',
    color: 'conductor-progress',
    icon: 'conductor-progress'
  },
  { id: 'in-review', label: 'In review', color: 'conductor-review', icon: 'conductor-review' },
  { id: 'completed', label: 'Completed', color: 'conductor-done', icon: 'conductor-done' }
] as const satisfies readonly WorkspaceStatusDefinition[]

export function cloneDefaultWorkspaceStatuses(): WorkspaceStatusDefinition[] {
  return DEFAULT_WORKSPACE_STATUSES.map((status) => ({ ...status }))
}

function sanitizeWorkspaceStatusLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback
  }
  const trimmed = value.trim().replace(/\s+/g, ' ')
  return trimmed ? trimmed.slice(0, MAX_STATUS_LABEL_LENGTH) : fallback
}

function slugWorkspaceStatusLabel(label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || 'status'
}

function sanitizeWorkspaceStatusId(value: unknown, fallbackLabel: string): WorkspaceStatus {
  if (typeof value !== 'string') {
    return slugWorkspaceStatusLabel(fallbackLabel)
  }
  const trimmed = value.trim().toLowerCase()
  if (!trimmed) {
    return slugWorkspaceStatusLabel(fallbackLabel)
  }
  return trimmed.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'status'
}

function sanitizeWorkspaceStatusColor(
  value: unknown,
  statusId: string,
  label: string,
  index: number,
  options: WorkspaceStatusNormalizationOptions
): string {
  if (
    options.migrateLegacyDefaultStatusVisuals === true &&
    ((statusId === 'in-progress' && label === 'In progress' && value === 'blue') ||
      (statusId === 'in-review' && label === 'In review' && value === 'violet') ||
      (statusId === 'completed' && label === 'Completed' && value === 'emerald')) &&
    DEFAULT_STATUS_VISUALS[statusId]
  ) {
    return DEFAULT_STATUS_VISUALS[statusId]?.color ?? DEFAULT_WORKSPACE_STATUS_COLOR_ID
  }
  if (typeof value === 'string' && WORKSPACE_STATUS_COLOR_IDS.some((id) => id === value)) {
    return value
  }
  const defaultVisual = DEFAULT_STATUS_VISUALS[statusId]
  if (defaultVisual) {
    return defaultVisual.color
  }
  return WORKSPACE_STATUS_COLOR_IDS[index % WORKSPACE_STATUS_COLOR_IDS.length]
}

function sanitizeWorkspaceStatusIcon(
  value: unknown,
  statusId: string,
  label: string,
  options: WorkspaceStatusNormalizationOptions
): string {
  if (
    options.migrateLegacyDefaultStatusVisuals === true &&
    ((statusId === 'in-progress' &&
      label === 'In progress' &&
      (value === 'circle-dot' || value === 'circle-progress')) ||
      (statusId === 'in-review' && label === 'In review' && value === 'git-pull-request') ||
      (statusId === 'completed' && label === 'Completed' && value === 'circle-check')) &&
    DEFAULT_STATUS_VISUALS[statusId]
  ) {
    return DEFAULT_STATUS_VISUALS[statusId]?.icon ?? DEFAULT_WORKSPACE_STATUS_ICON_ID
  }
  if (typeof value === 'string' && WORKSPACE_STATUS_ICON_IDS.some((id) => id === value)) {
    return value
  }
  return DEFAULT_STATUS_VISUALS[statusId]?.icon ?? DEFAULT_WORKSPACE_STATUS_ICON_ID
}

export function makeWorkspaceStatusId(
  label: string,
  existingStatuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  const base = slugWorkspaceStatusLabel(label)
  const existingIds = new Set(existingStatuses.map((status) => status.id))
  if (!existingIds.has(base)) {
    return base
  }
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base}-${index}`
    if (!existingIds.has(candidate)) {
      return candidate
    }
  }
  return `status-${Date.now().toString(36)}`
}

function normalizeWorkspaceStatusesInternal(
  value: unknown,
  options: WorkspaceStatusNormalizationOptions
): WorkspaceStatusDefinition[] {
  if (!Array.isArray(value)) {
    return cloneDefaultWorkspaceStatuses()
  }

  const statuses: WorkspaceStatusDefinition[] = []
  const usedIds = new Set<string>()
  for (const rawStatus of value.slice(0, MAX_WORKSPACE_STATUSES)) {
    if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
      continue
    }
    const raw = rawStatus as Record<string, unknown>
    const fallbackLabel = `Status ${statuses.length + 1}`
    const label = sanitizeWorkspaceStatusLabel(raw.label, fallbackLabel)
    let id = sanitizeWorkspaceStatusId(raw.id, label)
    if (usedIds.has(id)) {
      id = makeWorkspaceStatusId(label, statuses)
    }
    usedIds.add(id)
    statuses.push({
      id,
      label,
      color: sanitizeWorkspaceStatusColor(raw.color, id, label, statuses.length, options),
      icon: sanitizeWorkspaceStatusIcon(raw.icon, id, label, options)
    })
  }

  if (statuses.length === 0) {
    return cloneDefaultWorkspaceStatuses()
  }

  return statuses
}

export function normalizeWorkspaceStatuses(value: unknown): WorkspaceStatusDefinition[] {
  return normalizeWorkspaceStatusesInternal(value, {})
}

const PR_REORDERED_DEFAULT_STATUS_IDS = ['completed', 'in-review', 'in-progress', 'todo'] as const

const PR_REORDERED_DEFAULT_STATUSES = PR_REORDERED_DEFAULT_STATUS_IDS.map((id) => {
  const status = DEFAULT_WORKSPACE_STATUSES.find((entry) => entry.id === id)
  if (!status) {
    throw new Error(`Missing default workspace status: ${id}`)
  }
  return { ...status }
})

function isKnownBadPRReorderedDefaultStatusPayload(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== PR_REORDERED_DEFAULT_STATUSES.length) {
    return false
  }
  return value.every((rawStatus, index) => {
    if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
      return false
    }
    const raw = rawStatus as Record<string, unknown>
    const expected = PR_REORDERED_DEFAULT_STATUSES[index]
    return (
      Object.keys(raw).length === 4 &&
      raw.id === expected.id &&
      raw.label === expected.label &&
      raw.color === expected.color &&
      raw.icon === expected.icon
    )
  })
}

export function normalizePersistedWorkspaceStatuses(
  value: unknown,
  options: {
    repairReorderedDefaultStatuses?: boolean
    migrateLegacyDefaultStatusVisuals?: boolean
  } = {}
): WorkspaceStatusDefinition[] {
  // Why: this PR briefly wrote the default columns in reverse workflow order.
  // The repair is one-shot and checks the raw payload, because normalized
  // IDs/labels are indistinguishable from a user-authored column reorder.
  if (
    options.repairReorderedDefaultStatuses === true &&
    isKnownBadPRReorderedDefaultStatusPayload(value)
  ) {
    return cloneDefaultWorkspaceStatuses()
  }
  return normalizeWorkspaceStatusesInternal(value, {
    migrateLegacyDefaultStatusVisuals: options.migrateLegacyDefaultStatusVisuals
  })
}

export function clampWorkspaceBoardOpacity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1
  }
  return Math.min(1, Math.max(0.2, Math.round(value * 100) / 100))
}

export function normalizeWorkspaceBoardCompact(value: unknown): boolean {
  return value === true
}

export function isWorkspaceStatusId(
  value: string,
  statuses: readonly WorkspaceStatusDefinition[]
): value is WorkspaceStatus {
  return statuses.some((status) => status.id === value)
}

export function getDefaultWorkspaceStatusId(
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  return statuses.some((status) => status.id === DEFAULT_WORKSPACE_STATUS_ID)
    ? DEFAULT_WORKSPACE_STATUS_ID
    : (statuses[0]?.id ?? DEFAULT_WORKSPACE_STATUS_ID)
}

export function getWorkspaceStatus(
  worktree: Pick<Worktree, 'workspaceStatus'>,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus {
  return worktree.workspaceStatus && isWorkspaceStatusId(worktree.workspaceStatus, statuses)
    ? worktree.workspaceStatus
    : getDefaultWorkspaceStatusId(statuses)
}

export function getWorkspaceStatusGroupKey(status: WorkspaceStatus): string {
  return `${WORKSPACE_STATUS_GROUP_PREFIX}${encodeURIComponent(status)}`
}

export function getWorkspaceStatusFromGroupKey(
  groupKey: string,
  statuses: readonly WorkspaceStatusDefinition[]
): WorkspaceStatus | null {
  if (!groupKey.startsWith(WORKSPACE_STATUS_GROUP_PREFIX)) {
    return null
  }
  try {
    const status = decodeURIComponent(groupKey.slice(WORKSPACE_STATUS_GROUP_PREFIX.length))
    return isWorkspaceStatusId(status, statuses) ? status : null
  } catch {
    return null
  }
}

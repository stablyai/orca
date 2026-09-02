import {
  createDefaultWorkspaceCleanupFilterState,
  type WorkspaceCleanupFilterState
} from '../../../../shared/workspace-cleanup-filter-model'

export type WorkspaceCleanupFacetGroupKey = keyof Omit<WorkspaceCleanupFilterState, 'query'>

const FACET_GROUP_KEYS: readonly WorkspaceCleanupFacetGroupKey[] = [
  'activity',
  'size',
  'status',
  'agent',
  'git',
  'review',
  'ticket',
  'context',
  'location',
  'safety'
]

/**
 * Facet groups the user has moved off the default state. Drives the "N filters
 * on" badge.
 */
export function listActiveWorkspaceCleanupFacetGroups(
  filters: WorkspaceCleanupFilterState
): WorkspaceCleanupFacetGroupKey[] {
  const defaults = createDefaultWorkspaceCleanupFilterState()
  return FACET_GROUP_KEYS.filter((key) => !isGroupEqual(filters[key], defaults[key]))
}

export function hasActiveWorkspaceCleanupFilters(filters: WorkspaceCleanupFilterState): boolean {
  return (
    filters.query.trim().length > 0 || listActiveWorkspaceCleanupFacetGroups(filters).length > 0
  )
}

/** Selection order is not meaning, so array members compare as sets. */
function isGroupEqual(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false
    }
    const leftMembers = left.map(String).sort()
    const rightMembers = right.map(String).sort()
    return leftMembers.every((member, index) => member === rightMembers[index])
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) {
      return false
    }
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && isGroupEqual(trim(left[key]), trim(right[key]))
      )
    )
  }
  return left === right
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function trim(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value
}

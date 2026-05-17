const LEGACY_DEFAULT_STATUS_LABELS: Record<string, string> = {
  todo: 'Todo',
  'in-progress': 'In progress',
  'in-review': 'In review',
  completed: 'Completed'
}

const CONDUCTOR_DEFAULT_STATUS_VISUALS: Record<string, { color: string; icon: string }> = {
  todo: { color: 'neutral', icon: 'circle' },
  'in-progress': { color: 'conductor-progress', icon: 'conductor-progress' },
  'in-review': { color: 'conductor-review', icon: 'conductor-review' },
  completed: { color: 'conductor-done', icon: 'conductor-done' }
}

const LEGACY_DEFAULT_STATUS_VISUALS: Record<string, { color: string; icon: string }> = {
  todo: { color: 'neutral', icon: 'circle' },
  'in-progress': { color: 'blue', icon: 'circle-dot' },
  'in-review': { color: 'violet', icon: 'git-pull-request' },
  completed: { color: 'emerald', icon: 'circle-check' }
}

const LEGACY_TODO_FIRST_DEFAULT_STATUS_IDS = [
  'todo',
  'in-progress',
  'in-review',
  'completed'
] as const
const WORKFLOW_DEFAULT_STATUS_IDS = ['completed', 'in-review', 'in-progress', 'todo'] as const

function isLegacyDefaultStatusPayload(
  value: unknown,
  orderedIds: readonly string[],
  visuals: Record<string, { color: string; icon: string }>
): boolean {
  if (!Array.isArray(value) || value.length !== orderedIds.length) {
    return false
  }
  return value.every((rawStatus, index) => {
    if (!rawStatus || typeof rawStatus !== 'object' || Array.isArray(rawStatus)) {
      return false
    }
    const raw = rawStatus as Record<string, unknown>
    const expectedId = orderedIds[index]!
    const expectedVisual = visuals[expectedId]
    return (
      Object.keys(raw).length === 4 &&
      raw.id === expectedId &&
      raw.label === LEGACY_DEFAULT_STATUS_LABELS[expectedId] &&
      raw.color === expectedVisual?.color &&
      raw.icon === expectedVisual?.icon
    )
  })
}

export function isLegacyDefaultWorkflowStatusPayload(value: unknown): boolean {
  return (
    isLegacyDefaultStatusPayload(
      value,
      LEGACY_TODO_FIRST_DEFAULT_STATUS_IDS,
      CONDUCTOR_DEFAULT_STATUS_VISUALS
    ) ||
    isLegacyDefaultStatusPayload(
      value,
      LEGACY_TODO_FIRST_DEFAULT_STATUS_IDS,
      LEGACY_DEFAULT_STATUS_VISUALS
    ) ||
    isLegacyDefaultStatusPayload(
      value,
      WORKFLOW_DEFAULT_STATUS_IDS,
      CONDUCTOR_DEFAULT_STATUS_VISUALS
    ) ||
    isLegacyDefaultStatusPayload(value, WORKFLOW_DEFAULT_STATUS_IDS, LEGACY_DEFAULT_STATUS_VISUALS)
  )
}

export function isKnownBadPRReorderedDefaultStatusPayload(value: unknown): boolean {
  return isLegacyDefaultStatusPayload(
    value,
    WORKFLOW_DEFAULT_STATUS_IDS,
    CONDUCTOR_DEFAULT_STATUS_VISUALS
  )
}

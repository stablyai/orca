import type {
  LinearProjectDetail,
  LinearProjectSummary
} from '../../../shared/linear/project-types'

export type LinearProjectPresentation = (LinearProjectDetail | LinearProjectSummary) & {
  summary?: string
  health?: unknown
  lead?: unknown
  members?: unknown[]
  teams?: unknown[]
  labels?: unknown[]
  milestones?: unknown[]
  resources?: unknown[]
  latestUpdate?: unknown
  lastUpdate?: unknown
}

export function linearProjectUnknownText(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim()
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of ['name', 'label', 'displayName', 'title', 'status', 'body']) {
    const text = record[key]
    if (typeof text === 'string' && text.trim()) {
      return text.trim()
    }
  }
  return null
}

export function linearProjectDateLabel(value: string | null | undefined): string {
  if (!value) {
    return 'None'
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString()
}

export function linearProjectPriorityLabel(priority: unknown, fallback: unknown): string {
  const fromFallback = linearProjectUnknownText(fallback)
  if (fromFallback) {
    return fromFallback
  }
  if (typeof priority === 'number') {
    return priority === 0 ? 'None' : `P${priority}`
  }
  return linearProjectUnknownText(priority) ?? 'None'
}

export function linearProjectProgressPercent(project: LinearProjectPresentation): number | null {
  const progress = typeof project.progress === 'number' ? project.progress : null
  if (progress === null || !Number.isFinite(progress)) {
    return null
  }
  return progress <= 1 ? Math.round(progress * 100) : Math.round(progress)
}

export function linearProjectMetadataLabels(
  values: unknown[] | undefined,
  limit: number
): string[] {
  if (!Array.isArray(values)) {
    return []
  }
  return values
    .map((value) => linearProjectUnknownText(value))
    .filter((value): value is string => Boolean(value))
    .slice(0, limit)
}

export function linearProjectWorkspaceLabel(
  workspaceSelection: string | null | undefined,
  workspaceName?: string
): string | null {
  return workspaceSelection === 'all' && workspaceName ? workspaceName : null
}

export type BeadsIssueStatus = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed'

export type BeadsIssue = {
  id: string
  title: string
  description?: string
  status: BeadsIssueStatus
  priority: number
  issueType: string
  assignee?: string
  createdBy?: string
  labels: string[]
  createdAt: string
  updatedAt: string
  closedAt?: string
  dependencyCount: number
  dependentCount: number
  commentCount: number
}

export type BeadsWorkspaceStatus = {
  bdInstalled: boolean
  bdVersion: string | null
  versionSupported: boolean
  initialized: boolean
}

export type BeadsIssuePreset = 'open' | 'assigned' | 'ready'

const BEADS_ISSUE_STATUSES: readonly BeadsIssueStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'deferred',
  'closed'
]

function normalizeBeadsIssueStatus(value: unknown): BeadsIssueStatus {
  return BEADS_ISSUE_STATUSES.includes(value as BeadsIssueStatus)
    ? (value as BeadsIssueStatus)
    : 'open'
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** Parses one raw `bd list/show/ready --json` item; returns null for garbage. */
export function normalizeBeadsIssue(raw: unknown): BeadsIssue | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const item = raw as Record<string, unknown>
  if (typeof item.id !== 'string' || item.id.length === 0 || typeof item.title !== 'string') {
    return null
  }
  const createdAt = optionalString(item.created_at)
  const updatedAt = optionalString(item.updated_at)
  if (!createdAt || !updatedAt) {
    return null
  }
  const description = optionalString(item.description)
  // Why: `owner` is the creator, never the assignee — only explicit `assignee` counts.
  const assignee = optionalString(item.assignee)
  const createdBy = optionalString(item.created_by)
  const closedAt = optionalString(item.closed_at)
  return {
    id: item.id,
    title: item.title,
    ...(description !== undefined ? { description } : {}),
    status: normalizeBeadsIssueStatus(item.status),
    priority: countOf(item.priority),
    issueType: optionalString(item.issue_type) ?? 'task',
    ...(assignee !== undefined ? { assignee } : {}),
    ...(createdBy !== undefined ? { createdBy } : {}),
    labels: Array.isArray(item.labels)
      ? item.labels.filter((label): label is string => typeof label === 'string')
      : [],
    createdAt,
    updatedAt,
    ...(closedAt !== undefined ? { closedAt } : {}),
    dependencyCount: countOf(item.dependency_count),
    dependentCount: countOf(item.dependent_count),
    commentCount: countOf(item.comment_count)
  }
}

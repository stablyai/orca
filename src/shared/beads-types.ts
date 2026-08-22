export type BeadsIssueStatus = 'open' | 'in_progress' | 'blocked' | 'deferred' | 'closed'

export type BeadsIssue = {
  id: string
  title: string
  description?: string
  /** Second markdown body slot: design/approach. bd omits empty body fields. */
  design?: string
  acceptanceCriteria?: string
  /** Work-log slot (`bd update --append-notes`); tends to grow longest. */
  notes?: string
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

/** Related issue summary plus the edge type ('blocks' | 'parent-child' on bd 1.1.2; unknown types pass through). */
export type BeadsIssueRelation = BeadsIssue & { dependencyType: string }

export type BeadsIssueComment = {
  id: string
  author: string
  text: string
  createdAt: string
}

export type BeadsIssueDetails = {
  issue: BeadsIssue
  /** Parent issue id from the parent-child edge, if any. */
  parent: string | null
  /** Issues this one depends on (also includes the parent-child edge on bd 1.1.2). */
  dependencies: BeadsIssueRelation[]
  /** Issues depending on this one; bd emits them only with --include-dependents. */
  dependents: BeadsIssueRelation[]
  comments: BeadsIssueComment[]
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

/** Newest-first by updatedAt; Date.parse handles offset timestamps, localeCompare is the stable fallback. */
export function compareBeadsUpdatedAtDesc(a: BeadsIssue, b: BeadsIssue): number {
  const aTime = Date.parse(a.updatedAt)
  const bTime = Date.parse(b.updatedAt)
  if (Number.isNaN(aTime) || Number.isNaN(bTime)) {
    return b.updatedAt.localeCompare(a.updatedAt)
  }
  return bTime - aTime
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
  const design = optionalString(item.design)
  const acceptanceCriteria = optionalString(item.acceptance_criteria)
  const notes = optionalString(item.notes)
  // Why: `owner` is the creator, never the assignee — only explicit `assignee` counts.
  const assignee = optionalString(item.assignee)
  const createdBy = optionalString(item.created_by)
  const closedAt = optionalString(item.closed_at)
  return {
    id: item.id,
    title: item.title,
    ...(description !== undefined ? { description } : {}),
    ...(design !== undefined ? { design } : {}),
    ...(acceptanceCriteria !== undefined ? { acceptanceCriteria } : {}),
    ...(notes !== undefined ? { notes } : {}),
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

/** Relation entries reuse the issue normalizer; dependents carry zeroed-but-present timestamps on bd 1.1.2. */
export function normalizeBeadsIssueRelation(raw: unknown): BeadsIssueRelation | null {
  const issue = normalizeBeadsIssue(raw)
  if (!issue) {
    return null
  }
  const dependencyType = optionalString((raw as Record<string, unknown>).dependency_type)
  return { ...issue, dependencyType: dependencyType ?? 'blocks' }
}

export function normalizeBeadsIssueComment(raw: unknown): BeadsIssueComment | null {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  const item = raw as Record<string, unknown>
  const id = optionalString(item.id) ?? (typeof item.id === 'number' ? String(item.id) : undefined)
  const createdAt = optionalString(item.created_at)
  if (id === undefined || typeof item.text !== 'string' || !createdAt) {
    return null
  }
  return { id, author: optionalString(item.author) ?? '', text: item.text, createdAt }
}

function normalizeBeadsRelationArray(value: unknown): BeadsIssueRelation[] {
  return Array.isArray(value)
    ? value
        .map((raw) => normalizeBeadsIssueRelation(raw))
        .filter((relation): relation is BeadsIssueRelation => relation !== null)
    : []
}

/** Parses one raw `bd show --json` item; bd omits the arrays when empty or not requested (comments_omitted). */
export function normalizeBeadsIssueDetails(raw: unknown): BeadsIssueDetails | null {
  const issue = normalizeBeadsIssue(raw)
  if (!issue) {
    return null
  }
  const item = raw as Record<string, unknown>
  return {
    issue,
    parent: optionalString(item.parent) ?? null,
    dependencies: normalizeBeadsRelationArray(item.dependencies),
    dependents: normalizeBeadsRelationArray(item.dependents),
    comments: Array.isArray(item.comments)
      ? item.comments
          .map((entry) => normalizeBeadsIssueComment(entry))
          .filter((comment): comment is BeadsIssueComment => comment !== null)
      : []
  }
}

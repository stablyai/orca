// Why: shared wire + cache identity for Linear plain-list attribute facets.
// IPC/RPC parse unknown input; renderer canonicalizes typed state. An empty
// filter is omitted from transport so unfiltered list requests stay equivalent.

export const LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH = 256
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS = 100
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS = 100
export const LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_PRIORITIES = 5

export type LinearIssueAttributeAssignee = { kind: 'user'; id: string } | { kind: 'unassigned' }

export type LinearIssueAttributeFilter = {
  stateIds: string[]
  priorities: number[]
  assignee: LinearIssueAttributeAssignee | null
  labelIds: string[]
}

export const EMPTY_LINEAR_ISSUE_ATTRIBUTE_FILTER: LinearIssueAttributeFilter = Object.freeze({
  stateIds: Object.freeze([]) as unknown as string[],
  priorities: Object.freeze([]) as unknown as number[],
  assignee: null,
  labelIds: Object.freeze([]) as unknown as string[]
}) as LinearIssueAttributeFilter

const ATTRIBUTE_FILTER_KEYS = new Set(['stateIds', 'priorities', 'assignee', 'labelIds'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function canonicalizeIds(ids: string[]): string[] {
  const seen = new Set<string>()
  const next: string[] = []
  for (const raw of ids) {
    const id = raw.trim()
    if (!id || seen.has(id)) {
      continue
    }
    seen.add(id)
    next.push(id)
  }
  next.sort(compareStrings)
  return next
}

function canonicalizePriorities(priorities: number[]): number[] {
  const seen = new Set<number>()
  const next: number[] = []
  for (const priority of priorities) {
    if (!Number.isInteger(priority) || priority < 0 || priority > 4 || seen.has(priority)) {
      continue
    }
    seen.add(priority)
    next.push(priority)
  }
  next.sort((a, b) => a - b)
  return next
}

function canonicalizeAssignee(
  assignee: LinearIssueAttributeAssignee | null
): LinearIssueAttributeAssignee | null {
  if (assignee === null) {
    return null
  }
  if (assignee.kind === 'unassigned') {
    return { kind: 'unassigned' }
  }
  const id = assignee.id.trim()
  if (!id) {
    return null
  }
  return { kind: 'user', id }
}

export function emptyLinearIssueAttributeFilter(): LinearIssueAttributeFilter {
  return {
    stateIds: [],
    priorities: [],
    assignee: null,
    labelIds: []
  }
}

export function canonicalizeLinearIssueAttributeFilter(
  filter: LinearIssueAttributeFilter
): LinearIssueAttributeFilter {
  return {
    stateIds: canonicalizeIds(filter.stateIds),
    priorities: canonicalizePriorities(filter.priorities),
    assignee: canonicalizeAssignee(filter.assignee),
    labelIds: canonicalizeIds(filter.labelIds)
  }
}

export function isEmptyLinearIssueAttributeFilter(
  filter: LinearIssueAttributeFilter | null | undefined
): boolean {
  if (!filter) {
    return true
  }
  const canonical = canonicalizeLinearIssueAttributeFilter(filter)
  return (
    canonical.stateIds.length === 0 &&
    canonical.priorities.length === 0 &&
    canonical.assignee === null &&
    canonical.labelIds.length === 0
  )
}

export function linearIssueAttributeFilterSignature(
  filter: LinearIssueAttributeFilter | null | undefined
): string {
  if (!filter || isEmptyLinearIssueAttributeFilter(filter)) {
    return ''
  }
  const canonical = canonicalizeLinearIssueAttributeFilter(filter)
  return JSON.stringify({
    stateIds: canonical.stateIds,
    priorities: canonical.priorities,
    assignee: canonical.assignee,
    labelIds: canonical.labelIds
  })
}

function assertId(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Invalid Linear attribute filter: ${field} must be a string id`)
  }
  const id = value.trim()
  if (!id) {
    throw new Error(`Invalid Linear attribute filter: ${field} must be non-empty`)
  }
  if (id.length > LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH) {
    throw new Error(
      `Invalid Linear attribute filter: ${field} exceeds ${LINEAR_ISSUE_ATTRIBUTE_FILTER_ID_MAX_LENGTH} characters`
    )
  }
  return id
}

function assertIdArray(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`Invalid Linear attribute filter: ${field} must be an array`)
  }
  if (value.length > max) {
    throw new Error(`Invalid Linear attribute filter: ${field} exceeds ${max} entries`)
  }
  return value.map((entry, index) => assertId(entry, `${field}[${index}]`))
}

function assertPriorities(value: unknown): number[] {
  if (!Array.isArray(value)) {
    throw new Error('Invalid Linear attribute filter: priorities must be an array')
  }
  if (value.length > LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_PRIORITIES) {
    throw new Error(
      `Invalid Linear attribute filter: priorities exceeds ${LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_PRIORITIES} entries`
    )
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 4) {
      throw new Error(
        `Invalid Linear attribute filter: priorities[${index}] must be an integer from 0 to 4`
      )
    }
    return entry
  })
}

function assertAssignee(value: unknown): LinearIssueAttributeAssignee | null {
  if (value === null) {
    return null
  }
  if (!isPlainObject(value)) {
    throw new Error('Invalid Linear attribute filter: assignee must be an object or null')
  }
  const keys = Object.keys(value)
  if (value.kind === 'unassigned') {
    if (keys.some((key) => key !== 'kind')) {
      throw new Error('Invalid Linear attribute filter: unassigned assignee has unknown keys')
    }
    return { kind: 'unassigned' }
  }
  if (value.kind === 'user') {
    if (keys.some((key) => key !== 'kind' && key !== 'id')) {
      throw new Error('Invalid Linear attribute filter: user assignee has unknown keys')
    }
    return { kind: 'user', id: assertId(value.id, 'assignee.id') }
  }
  throw new Error('Invalid Linear attribute filter: assignee.kind must be "user" or "unassigned"')
}

/** Throwing parser for IPC/RPC wire input. Present partial objects are invalid. */
export function parseLinearIssueAttributeFilter(value: unknown): LinearIssueAttributeFilter {
  if (value === undefined || value === null) {
    throw new Error('Invalid Linear attribute filter: value is required when present')
  }
  if (!isPlainObject(value)) {
    throw new Error('Invalid Linear attribute filter: expected an object')
  }
  for (const key of Object.keys(value)) {
    if (!ATTRIBUTE_FILTER_KEYS.has(key)) {
      throw new Error(`Invalid Linear attribute filter: unknown key "${key}"`)
    }
  }
  if (
    !('stateIds' in value) ||
    !('priorities' in value) ||
    !('assignee' in value) ||
    !('labelIds' in value)
  ) {
    throw new Error(
      'Invalid Linear attribute filter: stateIds, priorities, assignee, and labelIds are required'
    )
  }

  const parsed: LinearIssueAttributeFilter = {
    stateIds: assertIdArray(
      value.stateIds,
      'stateIds',
      LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_STATE_IDS
    ),
    priorities: assertPriorities(value.priorities),
    assignee: assertAssignee(value.assignee),
    labelIds: assertIdArray(value.labelIds, 'labelIds', LINEAR_ISSUE_ATTRIBUTE_FILTER_MAX_LABEL_IDS)
  }
  return canonicalizeLinearIssueAttributeFilter(parsed)
}

export function optionalParsedLinearIssueAttributeFilter(
  value: unknown
): LinearIssueAttributeFilter | undefined {
  if (value === undefined) {
    return undefined
  }
  const parsed = parseLinearIssueAttributeFilter(value)
  return isEmptyLinearIssueAttributeFilter(parsed) ? undefined : parsed
}

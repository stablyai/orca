import { isRecord } from '../agent-status/child-work/agent-status-child-work-value-guards'
import type { ClickUpTaskListFilter } from './clickup-types'

const MAX_STATUS_FILTERS = 50
const MAX_STATUS_NAME_LENGTH = 200
const MAX_PAGE_INDEX = 1000

/** Narrows an untrusted list filter; anything unrecognized falls back to my open tasks. */
export function normalizeClickUpTaskListFilter(value: unknown): ClickUpTaskListFilter {
  const raw = isRecord(value) ? value : {}
  const statuses = Array.isArray(raw.statuses)
    ? raw.statuses
        .filter((status): status is string => typeof status === 'string')
        .map((status) => status.trim())
        .filter((status) => status.length > 0 && status.length <= MAX_STATUS_NAME_LENGTH)
        .slice(0, MAX_STATUS_FILTERS)
    : []
  return {
    scope: raw.scope === 'all' ? 'all' : 'assigned',
    includeClosed: raw.includeClosed === true,
    ...(statuses.length > 0 ? { statuses } : {})
  }
}

/** Page indexes are zero-based; invalid input reads the first page. */
export function normalizeClickUpPage(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_PAGE_INDEX
    ? value
    : 0
}

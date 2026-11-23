import { isRecord } from '../agent-status/child-work/agent-status-child-work-value-guards'
import type { ClickUpStatusOption, ClickUpTaskListFilter } from './clickup-types'

const MAX_STATUS_FILTERS = 50
const MAX_STATUS_NAME_LENGTH = 200
export const MAX_CLICKUP_PAGE_INDEX = 1000
export const CLICKUP_PAGE_RANGE_MESSAGE = `Page must be an integer from 0 to ${MAX_CLICKUP_PAGE_INDEX}.`

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

export function isClickUpPageIndex(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CLICKUP_PAGE_INDEX
  )
}

/** Page indexes are zero-based; a missing page reads the first, and an out-of-range one is rejected so a caller following `nextPage` never loops on page 0. */
export function normalizeClickUpPage(value: unknown): number {
  if (value === undefined || value === null) {
    return 0
  }
  if (!isClickUpPageIndex(value)) {
    throw new RangeError(CLICKUP_PAGE_RANGE_MESSAGE)
  }
  return value
}

/** ClickUp's `include_closed=false` drops only `closed` statuses; `done` ones must be dropped here. */
export function isClickUpStatusClosed(status: Pick<ClickUpStatusOption, 'type'>): boolean {
  return status.type === 'done' || status.type === 'closed'
}

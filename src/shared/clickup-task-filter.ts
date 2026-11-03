import type { ClickUpTaskFilter } from './clickup-types'

const CLICKUP_TASK_FILTERS: readonly ClickUpTaskFilter[] = [
  'assigned',
  'created',
  'all',
  'completed',
  'open'
]

export function isClickUpTaskFilter(value: unknown): value is ClickUpTaskFilter {
  return CLICKUP_TASK_FILTERS.some((filter) => filter === value)
}

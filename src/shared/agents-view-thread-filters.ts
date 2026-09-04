/** The two filter value domains, in menu order. The types below, the client
 *  schema's `z.enum`s and the normalizers all derive from these, so a new value
 *  cannot drift out of any of them. */
export const THREAD_READ_FILTER_VALUES = ['all', 'unread'] as const
export const ACTIVITY_GROUP_BY_VALUES = ['none', 'status', 'project', 'worktree', 'agent'] as const

export type ThreadReadFilter = (typeof THREAD_READ_FILTER_VALUES)[number]
export type ActivityGroupBy = (typeof ACTIVITY_GROUP_BY_VALUES)[number]

export const DEFAULT_AGENTS_READ_FILTER: ThreadReadFilter = 'all'
export const DEFAULT_AGENTS_GROUP_BY: ActivityGroupBy = 'status'

export function normalizeThreadReadFilter(value: unknown): ThreadReadFilter {
  return isMember(THREAD_READ_FILTER_VALUES, value) ? value : DEFAULT_AGENTS_READ_FILTER
}

export function normalizeActivityGroupBy(value: unknown): ActivityGroupBy {
  return isMember(ACTIVITY_GROUP_BY_VALUES, value) ? value : DEFAULT_AGENTS_GROUP_BY
}

function isMember<T extends string>(catalog: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (catalog as readonly string[]).includes(value)
}

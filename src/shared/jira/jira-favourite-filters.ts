import { z } from 'zod'
import { MAX_JIRA_SAVED_FILTER_JQL_LENGTH } from '../jira-saved-filters'
import { getUtf8ByteLength, isUtf8ByteLengthWithinLimit } from '../utf8-byte-limits'

export const MAX_JIRA_FAVOURITE_FILTERS = 100
export const MAX_JIRA_FAVOURITE_FILTER_NAME_LENGTH = 200
export const MAX_JIRA_FAVOURITE_FILTER_LIST_BYTES = 512 * 1024
const MAX_FILTER_CANDIDATES = 1000

const boundedText = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value.trim() === value)
const Filter = z.object({
  id: boundedText(128),
  name: boundedText(MAX_JIRA_FAVOURITE_FILTER_NAME_LENGTH),
  jql: boundedText(MAX_JIRA_SAVED_FILTER_JQL_LENGTH).refine((value) =>
    isUtf8ByteLengthWithinLimit(value, MAX_JIRA_SAVED_FILTER_JQL_LENGTH)
  ),
  siteId: boundedText(128).refine((value) => value !== 'all')
})
const List = z.object({
  filters: z.array(Filter).max(MAX_JIRA_FAVOURITE_FILTERS),
  truncated: z.boolean()
})

export type JiraFavouriteFilter = z.infer<typeof Filter>
export type JiraFavouriteFilterList = z.infer<typeof List>

function normalizeFilterId(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.trim()
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? String(value)
    : null
}

export function parseJiraFavouriteFilterList(
  value: unknown,
  siteId: string
): JiraFavouriteFilterList {
  Filter.shape.siteId.parse(siteId)
  const result = List.parse(value)
  const ids = new Set<string>()
  for (const filter of result.filters) {
    if (filter.siteId !== siteId || ids.has(filter.id)) {
      throw new Error('Invalid Jira favourite filter site or duplicate filter ID.')
    }
    ids.add(filter.id)
  }
  if (!isUtf8ByteLengthWithinLimit(JSON.stringify(result), MAX_JIRA_FAVOURITE_FILTER_LIST_BYTES)) {
    throw new Error('Jira favourite filter list exceeded the transfer limit.')
  }
  return result
}

export function normalizeJiraFavouriteFilters(
  value: unknown,
  siteId: string
): JiraFavouriteFilterList {
  Filter.shape.siteId.parse(siteId)
  if (!Array.isArray(value)) {
    throw new Error('Jira returned an invalid favourite filter list.')
  }
  const result: JiraFavouriteFilterList = { filters: [], truncated: false }
  const ids = new Set<string>()
  let bytes = getUtf8ByteLength(JSON.stringify(result))
  for (let index = 0; index < Math.min(value.length, MAX_FILTER_CANDIDATES); index += 1) {
    const candidate: unknown = value[index]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      result.truncated = true
      continue
    }
    const parsed = Filter.safeParse({
      id: 'id' in candidate ? normalizeFilterId(candidate.id) : null,
      name:
        'name' in candidate && typeof candidate.name === 'string' ? candidate.name.trim() : null,
      jql: 'jql' in candidate && typeof candidate.jql === 'string' ? candidate.jql.trim() : null,
      siteId
    })
    if (!parsed.success) {
      result.truncated = true
      continue
    }
    const filter = parsed.data
    if (ids.has(filter.id)) {
      continue
    }
    const filterBytes = getUtf8ByteLength(JSON.stringify(filter)) + 1
    if (
      result.filters.length === MAX_JIRA_FAVOURITE_FILTERS ||
      bytes + filterBytes > MAX_JIRA_FAVOURITE_FILTER_LIST_BYTES
    ) {
      result.truncated = true
      break
    }
    result.filters.push(filter)
    ids.add(filter.id)
    bytes += filterBytes
  }
  if (value.length > MAX_FILTER_CANDIDATES) {
    result.truncated = true
  }
  return result
}

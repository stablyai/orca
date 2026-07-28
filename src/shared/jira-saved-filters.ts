export const MAX_JIRA_SAVED_FILTERS = 50
export const MAX_JIRA_SAVED_FILTER_ID_LENGTH = 128
export const MAX_JIRA_SAVED_FILTER_NAME_LENGTH = 80
export const MAX_JIRA_SAVED_FILTER_JQL_LENGTH = 10_000

export type JiraSavedFilter = {
  id: string
  name: string
  jql: string
}

function normalizeBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim()
  if (normalized.length === 0 || normalized.length > maxLength) {
    return null
  }
  return normalized
}

export function normalizeJiraSavedFilters(value: unknown): JiraSavedFilter[] {
  if (!Array.isArray(value)) {
    return []
  }

  const normalized: JiraSavedFilter[] = []
  const ids = new Set<string>()
  const names = new Set<string>()

  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      continue
    }
    const input = candidate as Record<string, unknown>
    const id = normalizeBoundedString(input.id, MAX_JIRA_SAVED_FILTER_ID_LENGTH)
    const name = normalizeBoundedString(input.name, MAX_JIRA_SAVED_FILTER_NAME_LENGTH)
    const jql = normalizeBoundedString(input.jql, MAX_JIRA_SAVED_FILTER_JQL_LENGTH)
    if (!id || !name || !jql) {
      continue
    }

    const normalizedName = name.toLowerCase()
    if (ids.has(id) || names.has(normalizedName)) {
      continue
    }

    normalized.push({ id, name, jql })
    ids.add(id)
    names.add(normalizedName)
    if (normalized.length === MAX_JIRA_SAVED_FILTERS) {
      break
    }
  }

  return normalized
}

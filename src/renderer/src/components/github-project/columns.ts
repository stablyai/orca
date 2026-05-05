// Why: column visibility is a renderer-only preference — GitHub's view
// definition is the source of truth for which fields exist, and we layer a
// local visibility filter on top. Persisted in localStorage (not settings)
// because it's purely cosmetic per device and would otherwise bloat the
// debounced settings write on every checkbox toggle.
import type { GitHubProjectField, GitHubProjectView } from '../../../../shared/github-project-types'

export const TYPE_FIELD_ID = '__type__'
export const TYPE_FIELD_DATA_TYPE = '__TYPE__'

// Why: synthetic "Type" column derives from row.itemType — there is no
// matching ProjectV2 field, so we inject it client-side. Inserted right
// after TITLE so users see issue/PR/draft glyphs adjacent to the title.
export const TYPE_FIELD: GitHubProjectField = {
  kind: 'field',
  id: TYPE_FIELD_ID,
  name: 'Type',
  dataType: TYPE_FIELD_DATA_TYPE
}

export function getAvailableColumns(view: GitHubProjectView): GitHubProjectField[] {
  const fields = view.fields
  const titleIdx = fields.findIndex((f) => f.dataType === 'TITLE')
  if (titleIdx === -1) {
    return [TYPE_FIELD, ...fields]
  }
  return [...fields.slice(0, titleIdx + 1), TYPE_FIELD, ...fields.slice(titleIdx + 1)]
}

const STORAGE_KEY = 'orca.githubProject.hiddenColumns'

type HiddenMap = Record<string, string[]>

function readMap(): HiddenMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as HiddenMap) : {}
  } catch {
    return {}
  }
}

function writeMap(map: HiddenMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage may be disabled — visibility just won't persist this session.
  }
}

export function loadHiddenColumns(scopeKey: string): ReadonlySet<string> {
  const map = readMap()
  return new Set(map[scopeKey] ?? [])
}

export function saveHiddenColumns(scopeKey: string, hidden: ReadonlySet<string>): void {
  const map = readMap()
  if (hidden.size === 0) {
    delete map[scopeKey]
  } else {
    map[scopeKey] = Array.from(hidden)
  }
  writeMap(map)
}

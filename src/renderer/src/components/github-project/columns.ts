import { translate } from '@/i18n/i18n'
// Store per-device visibility locally without modifying GitHub’s field definition or syncing cosmetic settings.
import type { GitHubProjectField, GitHubProjectView } from '../../../../shared/github/project-types'

export const TYPE_FIELD_ID = '__type__'
export const TYPE_FIELD_DATA_TYPE = '__TYPE__'

// Inject Type after TITLE because row.itemType has no corresponding ProjectV2 field.
export const TYPE_FIELD: GitHubProjectField = {
  kind: 'field',
  id: TYPE_FIELD_ID,
  get name() {
    return translate('projectViews.columns.type', 'Type')
  },
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

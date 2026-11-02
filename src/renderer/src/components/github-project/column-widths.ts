// Keep cosmetic widths per device in localStorage; frozen columns use pixels, later columns use fr weights.
import type { GitHubProjectField } from '../../../../shared/github/project-types'

const STORAGE_KEY = 'orca.githubProject.columnWidths'

export const DEFAULT_TITLE_WIDTH = 360
export const DEFAULT_FIELD_WIDTH = 140
export const ACTION_COLUMN_WIDTH = 80
export const MIN_COLUMN_WIDTH = 60

type WidthMap = Record<string, Record<string, number>>

function readMap(): WidthMap {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as WidthMap) : {}
  } catch {
    return {}
  }
}

function writeMap(map: WidthMap): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {
    // localStorage may be disabled — widths just won't persist this session.
  }
}

export function loadColumnWidths(scopeKey: string): Readonly<Record<string, number>> {
  const map = readMap()
  return map[scopeKey] ?? {}
}

export function saveColumnWidths(scopeKey: string, widths: Record<string, number>): void {
  const map = readMap()
  if (Object.keys(widths).length === 0) {
    delete map[scopeKey]
  } else {
    map[scopeKey] = widths
  }
  writeMap(map)
}

export function defaultWidthFor(field: GitHubProjectField): number {
  return field.dataType === 'TITLE' ? DEFAULT_TITLE_WIDTH : DEFAULT_FIELD_WIDTH
}

export function resolveWidth(
  field: GitHubProjectField,
  widths: Readonly<Record<string, number>>
): number {
  const stored = widths[field.id]
  if (typeof stored === 'number' && stored >= MIN_COLUMN_WIDTH) {
    return stored
  }
  return defaultWidthFor(field)
}

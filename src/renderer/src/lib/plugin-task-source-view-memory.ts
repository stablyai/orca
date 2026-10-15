/**
 * Per-device memory of each plugin task source's search and filters, so the
 * list comes back as the user left it after visiting other pages or restarting.
 * Client-local on purpose: the synced task resume state is strict, and a key an
 * older host lacks would make it drop the whole state.
 */

const STORAGE_KEY = 'orca.plugin-task-source-views.v1'
const MAX_SOURCES = 32
const MAX_FILTERS = 8
const MAX_VALUE_LENGTH = 256
const MAX_QUERY_LENGTH = 512

export type PluginTaskSourceView = {
  query: string
  filters: Record<string, string>
}

const EMPTY_VIEW: PluginTaskSourceView = { query: '', filters: {} }
let views: Map<string, PluginTaskSourceView> | undefined

function sanitizeView(value: unknown): PluginTaskSourceView | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const cleanFilters: Record<string, string> = {}
  if ('filters' in value && value.filters && typeof value.filters === 'object') {
    for (const [key, filterValue] of Object.entries(value.filters).slice(0, MAX_FILTERS)) {
      if (typeof filterValue === 'string' && filterValue.length <= MAX_VALUE_LENGTH) {
        cleanFilters[key] = filterValue
      }
    }
  }
  return {
    query:
      'query' in value && typeof value.query === 'string'
        ? value.query.slice(0, MAX_QUERY_LENGTH)
        : '',
    filters: cleanFilters
  }
}

function viewMap(): Map<string, PluginTaskSourceView> {
  if (views) {
    return views
  }
  views = new Map()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(saved)) {
      for (const entry of saved.slice(-MAX_SOURCES)) {
        const view = Array.isArray(entry) && typeof entry[0] === 'string' && sanitizeView(entry[1])
        if (view) {
          views.set(entry[0], view)
        }
      }
    }
  } catch {
    // Storage may be unavailable; the session still remembers views in memory.
  }
  return views
}

export function readPluginTaskSourceView(sourceKey: string): PluginTaskSourceView {
  return viewMap().get(sourceKey) ?? EMPTY_VIEW
}

export function savePluginTaskSourceView(sourceKey: string, view: PluginTaskSourceView): void {
  const map = viewMap()
  // Why: re-insert so the most recently used sources survive the cap.
  map.delete(sourceKey)
  map.set(sourceKey, view)
  while (map.size > MAX_SOURCES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map.entries()]))
  } catch {
    // Quota or privacy mode: keep the in-memory copy.
  }
}

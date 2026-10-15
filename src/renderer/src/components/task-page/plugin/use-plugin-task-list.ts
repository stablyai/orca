import { useCallback, useEffect, useState } from 'react'
import type { PluginTaskListResult } from '../../../../../shared/plugins/plugin-task-source'
import type { ActivePluginTaskSource } from '@/store/plugin-task-sources'
import {
  readPluginTaskSourceView,
  savePluginTaskSourceView
} from '@/lib/plugin-task-source-view-memory'
import { pluginTaskErrorMessage } from './plugin-task-error-message'
import { reconcileFilterSelection } from './plugin-task-filter-selection'

const SEARCH_DEBOUNCE_MS = 250

// Why: revisiting a source paints its last list for the same view at once, then refreshes.
const lastListBySource = new Map<string, { viewKey: string; result: PluginTaskListResult }>()

function viewKeyOf(query: string, filters: Record<string, string>): string {
  return JSON.stringify([query, Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))])
}

export type PluginTaskListState = {
  searchInput: string
  setSearchInput: (value: string) => void
  filters: Record<string, string>
  setFilter: (filterId: string, value: string) => void
  result: PluginTaskListResult | null
  loading: boolean
  error: string | null
  refresh: () => void
}

/** Mount once per source (key the caller on the source) so state never leaks between sources. */
export function usePluginTaskList(source: ActivePluginTaskSource): PluginTaskListState {
  const [initialView] = useState(() => readPluginTaskSourceView(source.key))
  const [searchInput, setSearchInput] = useState(initialView.query)
  const [query, setQuery] = useState(initialView.query)
  const [filters, setFilters] = useState<Record<string, string>>(initialView.filters)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [result, setResult] = useState<PluginTaskListResult | null>(() => {
    const cached = lastListBySource.get(source.key)
    return cached?.viewKey === viewKeyOf(initialView.query, initialView.filters)
      ? cached.result
      : null
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    savePluginTaskSourceView(source.key, { query, filters })
    const viewKey = viewKeyOf(query, filters)
    window.api.plugins
      .listTaskSourceItems({
        pluginKey: source.pluginKey,
        sourceId: source.sourceId,
        params: { query, filters }
      })
      .then((next) => {
        if (cancelled) {
          return
        }
        lastListBySource.set(source.key, { viewKey, result: next })
        setResult(next)
        setError(null)
        // Why: a stale remembered value would keep being sent and saved while its picker shows the default.
        setFilters((current) => reconcileFilterSelection(current, next.filters ?? []))
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setError(pluginTaskErrorMessage(failure))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [filters, query, refreshNonce, source.key, source.pluginKey, source.sourceId])

  const setFilter = useCallback((filterId: string, value: string) => {
    setFilters((current) => ({ ...current, [filterId]: value }))
  }, [])
  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), [])

  return { searchInput, setSearchInput, filters, setFilter, result, loading, error, refresh }
}

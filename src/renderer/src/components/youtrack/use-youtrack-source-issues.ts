import { useEffect, useMemo, useState } from 'react'
import type { YouTrackIssue } from '../../../../shared/youtrack-types'
import { useYouTrackIssueSuggestions } from './use-youtrack-issue-reference'
import { useYouTrackVisible } from './use-youtrack-visible'
import { useYouTrackStore } from './youtrack-store'

const SEARCH_LIMIT = 30
const NO_ISSUES: YouTrackIssue[] = []

/** Issues for the Create worktree source field: ID/URL suggestions, plus text search in the YouTrack tab. */
export function useYouTrackSourceIssues({
  value,
  debouncedQuery,
  suggest,
  search
}: {
  value: string
  debouncedQuery: string
  suggest: boolean
  search: boolean
}): { issues: YouTrackIssue[]; loading: boolean } {
  const suggestions = useYouTrackIssueSuggestions(value, suggest)
  const connected = useYouTrackStore((s) => s.status.connected)
  const visible = useYouTrackVisible()
  const active = search && connected && visible
  const query = debouncedQuery.trim()
  const [result, setResult] = useState<{ query: string; issues: YouTrackIssue[] } | null>(null)

  useEffect(() => {
    const api = window.api?.youtrack
    if (!active || !api) {
      return
    }
    let cancelled = false
    void api
      .listIssues(
        query
          ? { query: `${query} #Unresolved`, limit: SEARCH_LIMIT }
          : { preset: 'assigned', limit: SEARCH_LIMIT }
      )
      .then((response) => {
        if (!cancelled) {
          setResult({ query, issues: response.ok ? response.issues : NO_ISSUES })
        }
      })
    return () => {
      cancelled = true
    }
  }, [active, query])

  const searched = active ? (result?.issues ?? NO_ISSUES) : NO_ISSUES
  // Why memo: the source field keys effects on its rows, so a fresh array per render would loop.
  const issues = useMemo(() => {
    const seen = new Set(suggestions.map((issue) => issue.idReadable))
    return [...suggestions, ...searched.filter((issue) => !seen.has(issue.idReadable))]
  }, [searched, suggestions])
  return { issues, loading: active && result?.query !== query }
}

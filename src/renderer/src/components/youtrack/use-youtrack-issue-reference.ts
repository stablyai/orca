import { useEffect, useMemo, useState } from 'react'
import type { YouTrackIssue } from '../../../../shared/youtrack-types'
import {
  parseYouTrackIssueIdPrefix,
  parseYouTrackIssueReference
} from '../../../../shared/youtrack-issue-reference'
import { useYouTrackStore } from './youtrack-store'
import { useYouTrackVisible } from './use-youtrack-visible'

const LOOKUP_DEBOUNCE_MS = 250
const ASSIGNED_CACHE_TTL_MS = 60_000
const MAX_SUGGESTIONS = 8

// Why module-level: reopening the dialog or retyping a prefix reuses one fetch per minute.
// Keyed by instance + viewer so switching accounts never shows the previous account's issues.
let assignedCache: { key: string; at: number; issues: YouTrackIssue[] } | null = null
let assignedInFlight: { key: string; promise: Promise<YouTrackIssue[]> } | null = null

function loadAssignedIssues(accountKey: string): Promise<YouTrackIssue[]> {
  const api = window.api?.youtrack
  if (!api) {
    return Promise.resolve([])
  }
  if (assignedCache?.key === accountKey && Date.now() - assignedCache.at < ASSIGNED_CACHE_TTL_MS) {
    return Promise.resolve(assignedCache.issues)
  }
  if (assignedInFlight?.key !== accountKey) {
    const promise = api
      .listIssues({ preset: 'assigned', limit: 100 })
      .then((result) => {
        // Why: failures aren't cached, so the next keystroke retries.
        if (!result.ok) {
          return []
        }
        assignedCache = { key: accountKey, at: Date.now(), issues: result.issues }
        return result.issues
      })
      .finally(() => {
        if (assignedInFlight?.promise === promise) {
          assignedInFlight = null
        }
      })
    assignedInFlight = { key: accountKey, promise }
  }
  return assignedInFlight.promise
}

/**
 * YouTrack issues for the create-worktree Smart field: a typed ID or issue URL once YouTrack
 * confirms it, then the viewer's open assigned issues whose ID starts with the typed prefix.
 */
export function useYouTrackIssueSuggestions(value: string, enabled: boolean): YouTrackIssue[] {
  const connected = useYouTrackStore((s) => s.status.connected)
  const statusChecked = useYouTrackStore((s) => s.statusChecked)
  const baseUrl = useYouTrackStore((s) => s.status.baseUrl)
  const viewerLogin = useYouTrackStore((s) => s.status.viewer?.login ?? '')
  const checkStatus = useYouTrackStore((s) => s.checkStatus)
  const [resolved, setResolved] = useState<YouTrackIssue | null>(null)
  const [assigned, setAssigned] = useState<YouTrackIssue[]>([])
  // Why: hiding YouTrack in Settings → Tasks must also stop it querying from Create worktree.
  const visible = useYouTrackVisible()
  const active = enabled && connected && visible
  const issueId = active ? parseYouTrackIssueReference(value, baseUrl) : null
  const prefix = active ? parseYouTrackIssueIdPrefix(value) : null

  useEffect(() => {
    if (enabled && visible && !statusChecked) {
      void checkStatus()
    }
  }, [checkStatus, enabled, statusChecked, visible])

  useEffect(() => {
    if (!prefix) {
      return
    }
    let cancelled = false
    void loadAssignedIssues(`${baseUrl}|${viewerLogin}`).then((issues) => {
      if (!cancelled) {
        setAssigned(issues)
      }
    })
    return () => {
      cancelled = true
    }
  }, [prefix, baseUrl, viewerLogin])

  useEffect(() => {
    const api = window.api?.youtrack
    if (!issueId || !api) {
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void api.getIssue({ idReadable: issueId }).then((result) => {
        if (!cancelled && result.ok) {
          setResolved(result.issue)
        }
      })
    }, LOOKUP_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [issueId])

  // Why: a lookup for an earlier ID must not surface once the input moved on.
  const exact =
    resolved && issueId && resolved.idReadable.toUpperCase() === issueId ? resolved : null
  // Why memo: the Smart field keys effects on its rows, so a fresh array per render would loop.
  return useMemo(() => {
    const suggestions = prefix
      ? assigned.filter(
          (issue) =>
            issue.idReadable.toUpperCase().startsWith(prefix) &&
            issue.idReadable !== exact?.idReadable
        )
      : []
    return [...(exact ? [exact] : []), ...suggestions].slice(0, MAX_SUGGESTIONS)
  }, [assigned, exact, prefix])
}

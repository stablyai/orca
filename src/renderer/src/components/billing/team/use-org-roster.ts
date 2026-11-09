import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { OrcaProfileOrgMembersListResult } from '../../../../../shared/orca-profiles'

// One shared read per org: the Team page, seat counts and workspace owner chips all use the
// same roster, so several mounted readers cost one IPC call (and one auth roster read).
type Entry = {
  result: OrcaProfileOrgMembersListResult | null
  loading: boolean
  inFlight: Promise<void> | null
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const MAX_CACHED_ORGS = 16

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

function readRoster(orgId: string): Promise<OrcaProfileOrgMembersListResult> {
  return window.api.orcaProfiles
    .orgMembersList({ orgId })
    .catch((error: unknown): OrcaProfileOrgMembersListResult => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }))
}

/** Starts a read unless one is already running for this org. */
export function loadOrgRoster(orgId: string): Promise<void> {
  const existing = entries.get(orgId)
  if (existing?.inFlight) {
    return existing.inFlight
  }
  const entry: Entry = existing ?? { result: null, loading: true, inFlight: null }
  const inFlight = readRoster(orgId).then((result) => {
    // Keep the last good roster through a transient failure so the list doesn't vanish.
    const keep = result.status !== 'ok' && entry.result?.status === 'ok'
    entries.set(orgId, { result: keep ? entry.result : result, loading: false, inFlight: null })
    emit()
  })
  entries.delete(orgId)
  entries.set(orgId, { ...entry, loading: true, inFlight })
  while (entries.size > MAX_CACHED_ORGS) {
    const oldest = entries.keys().next()
    if (oldest.done) {
      break
    }
    entries.delete(oldest.value)
  }
  emit()
  return inFlight
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const EMPTY: Entry = { result: null, loading: false, inFlight: null }

/** The org's live roster (members, pending invites, viewer role). `refresh()` re-reads it. */
export function useOrgRoster(orgId: string | null): {
  loading: boolean
  result: OrcaProfileOrgMembersListResult | null
  refresh: () => void
} {
  const entry = useSyncExternalStore(subscribe, () =>
    orgId ? (entries.get(orgId) ?? EMPTY) : EMPTY
  )
  useEffect(() => {
    if (orgId) {
      void loadOrgRoster(orgId)
    }
  }, [orgId])
  const refresh = useCallback(() => {
    if (orgId) {
      void loadOrgRoster(orgId)
    }
  }, [orgId])
  return { loading: entry.loading, result: entry.result, refresh }
}

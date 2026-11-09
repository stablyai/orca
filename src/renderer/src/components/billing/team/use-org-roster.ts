import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { OrcaProfileOrgMembersListResult } from '../../../../../shared/orca-profiles'

// One shared read per org: the Team page, seat counts and workspace owner chips all use the
// same roster, so several mounted readers cost one IPC call (and one auth roster read).
type Entry = {
  result: OrcaProfileOrgMembersListResult | null
  /** Sequence number of the read that produced `result` (0 before the first answer). */
  resultSeq: number
  loading: boolean
  inFlight: Promise<void> | null
  /** A refresh arrived while a read was running; read once more when it ends. */
  dirty: boolean
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()
const MAX_CACHED_ORGS = 16
let readCounter = 0

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

/** The sequence number the next read will be above; reads started later see later changes. */
export function currentRosterReadSeq(): number {
  return readCounter
}

function put(orgId: string, entry: Entry): void {
  entries.delete(orgId)
  entries.set(orgId, entry)
  while (entries.size > MAX_CACHED_ORGS) {
    const oldest = entries.keys().next()
    if (oldest.done) {
      break
    }
    entries.delete(oldest.value)
  }
}

/**
 * Reads the roster. A call during a running read doesn't reuse its (possibly stale) answer: it
 * marks the entry dirty so one more read runs right after, which sees every change made so far.
 */
export function loadOrgRoster(orgId: string): Promise<void> {
  const existing = entries.get(orgId)
  if (existing?.inFlight) {
    existing.dirty = true
    return existing.inFlight
  }
  const seq = ++readCounter
  const inFlight = readRoster(orgId).then((result) => {
    const current = entries.get(orgId)
    const previous = current?.result ?? null
    // Keep the last good roster through a transient failure so the list doesn't vanish.
    const keep = result.status !== 'ok' && previous?.status === 'ok'
    const rerun = current?.dirty === true
    put(orgId, {
      result: keep ? previous : result,
      resultSeq: keep ? (current?.resultSeq ?? 0) : seq,
      loading: rerun,
      inFlight: null,
      dirty: false
    })
    emit()
    if (rerun) {
      void loadOrgRoster(orgId)
    }
  })
  put(orgId, {
    result: existing?.result ?? null,
    resultSeq: existing?.resultSeq ?? 0,
    loading: true,
    inFlight,
    dirty: false
  })
  emit()
  return inFlight
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const EMPTY: Entry = { result: null, resultSeq: 0, loading: false, inFlight: null, dirty: false }

/** The org's live roster (members, pending invites, viewer role). `refresh()` re-reads it. */
export function useOrgRoster(orgId: string | null): {
  loading: boolean
  result: OrcaProfileOrgMembersListResult | null
  resultSeq: number
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
  return {
    loading: entry.loading,
    result: entry.result,
    resultSeq: entry.resultSeq,
    refresh
  }
}

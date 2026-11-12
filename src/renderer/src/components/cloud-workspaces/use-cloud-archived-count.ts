// How many archived cloud workspaces Home's scope has, so Home can always reach them (ARCHIVE-REACH):
// with only a few active workspaces Home hides its filter row (JA-30), and that row holds the only
// Archived switch, so archiving your only workspace used to leave nothing on Home to get it back.
//
// One `archived=only` read per account, scope and active list. When the active list changes (a
// workspace archived or unarchived, here or elsewhere), the count is read again. Otherwise a cached
// answer is reused for a few minutes, so Home's polling never doubles its reads. An archive,
// unarchive or delete from this desktop starts a fresh read at once (cloud-archive-changes): the
// active list can change before the archive commits, and its cached 0 must not stand for 5 minutes.
import { useEffect, useState, useSyncExternalStore } from 'react'
import {
  cloudArchiveVersion,
  subscribeCloudArchiveChanges
} from '@/lib/orca-cloud/cloud-archive-changes'

const TTL_MS = 5 * 60_000

type Cached = { count: number; at: number }
const cache = new Map<string, Cached>()
const inflight = new Map<string, Promise<number | null>>()

async function readArchivedCount(scope: 'team' | 'mine'): Promise<number | null> {
  try {
    const result = await window.api.cloudWorkspaces.list({ scope, archived: 'only' })
    return result.ok ? result.value.length : null
  } catch {
    return null
  }
}

function load(key: string, scope: 'team' | 'mine', now: number): Promise<number | null> {
  const hit = cache.get(key)
  if (hit && now - hit.at < TTL_MS) {
    return Promise.resolve(hit.count)
  }
  const pending = inflight.get(key)
  if (pending) {
    return pending
  }
  const request = readArchivedCount(scope).then((count) => {
    inflight.delete(key)
    if (count !== null) {
      cache.set(key, { count, at: Date.now() })
    }
    return count
  })
  inflight.set(key, request)
  return request
}

/**
 * Null until known (or when the read failed): callers then keep today's behavior. `activeIds` is the
 * active list Home shows; null while it loads. Disabled while the Archived switch is already on.
 */
export function useCloudArchivedCount({
  account,
  scope,
  activeIds,
  enabled
}: {
  account: string
  scope: 'team' | 'mine'
  activeIds: readonly string[] | null
  enabled: boolean
}): number | null {
  const signature = activeIds ? [...activeIds].sort().join(',') : null
  const changes = useSyncExternalStore(subscribeCloudArchiveChanges, cloudArchiveVersion)
  const key = JSON.stringify({ account, scope, active: signature, changes })
  const [state, setState] = useState<{ key: string; count: number | null }>({ key, count: null })
  useEffect(() => {
    if (!enabled || signature === null) {
      return
    }
    let disposed = false
    void load(key, scope, Date.now()).then((count) => {
      if (!disposed) {
        setState({ key, count })
      }
    })
    return () => {
      disposed = true
    }
  }, [enabled, key, scope, signature])
  if (!enabled) {
    return null
  }
  // A count read for an earlier active list still says whether archived ones exist; keep it until
  // the new read lands so the switch doesn't flicker off and on.
  return state.count
}

/**
 * Home's two numbers: `archivedRead` (the count while the active list shows, for the empty state)
 * and `archivedCount` (the switch's label: with the switch on, the archived rows shown).
 */
export function useHomeArchivedCount({
  account,
  scope,
  shown,
  archivedOn,
  enabled
}: {
  account: string
  scope: 'team' | 'mine'
  /** The rows Home shows now; null while they load. */
  shown: readonly { id: string }[] | null
  archivedOn: boolean
  enabled: boolean
}): { archivedRead: number | null; archivedCount: number | null } {
  const archivedRead = useCloudArchivedCount({
    account,
    scope,
    activeIds: shown ? shown.map((w) => w.id) : null,
    enabled: enabled && !archivedOn
  })
  return { archivedRead, archivedCount: archivedOn ? (shown?.length ?? null) : archivedRead }
}

/** Tests: forget every cached count. */
export function resetCloudArchivedCountCache(): void {
  cache.clear()
  inflight.clear()
}

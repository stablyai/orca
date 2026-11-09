// Window-side cache of Orca Cloud workspace lifecycle: which workspaces are cloud, their last
// status from the control plane, in-flight wakes and OOM notices. The one source of cloud ids and
// wake state for every cloud surface. A tiny external store (not an app-store slice) so the
// hundreds of sidebar rows that are not cloud workspaces subscribe to nothing.
import { useSyncExternalStore } from 'react'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import type {
  CloudOomEvent,
  CloudWakeProgressEvent,
  CloudWorkspaceResult,
  OrcaCloudWorkspaceApi
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedWorkspaceStatus } from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'
import { WAKE_FAILED_STALE_MS } from './orca-cloud-workspace-state'

export type CloudStatusEntry = {
  status: HostedWorkspaceStatus | null
  loading: boolean
  error: string | null
  fetchedAt: number | null
}

export type CloudWorkspaceSnapshot = {
  ids: ReadonlySet<string>
  /** True once the first id list arrived (until then "not cloud" is unknown, not false). */
  idsLoaded: boolean
  status: Readonly<Record<string, CloudStatusEntry>>
  /** In-flight or failed wakes only; a settled wake is removed. */
  wake: Readonly<Record<string, CloudWakeProgressEvent>>
  oom: Readonly<Record<string, CloudOomEvent>>
  /** OOM kill count the user dismissed, per workspace. */
  oomDismissed: Readonly<Record<string, number>>
  /** Restart/archive/unarchive in flight, per workspace. */
  pending: Readonly<Record<string, 'restart' | 'archive' | 'unarchive'>>
}

const EMPTY: CloudWorkspaceSnapshot = {
  ids: new Set(),
  idsLoaded: false,
  status: {},
  wake: {},
  oom: {},
  oomDismissed: {},
  pending: {}
}

let snapshot: CloudWorkspaceSnapshot = EMPTY
const listeners = new Set<() => void>()

/** Store writes; exported for the lifecycle actions module only. */
export function updateCloudWorkspaceSnapshot(
  patch: (current: CloudWorkspaceSnapshot) => Partial<CloudWorkspaceSnapshot>
): void {
  snapshot = { ...snapshot, ...patch(snapshot) }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getCloudWorkspaceSnapshot(): CloudWorkspaceSnapshot {
  return snapshot
}

/** Selector hook; return primitives or stable references from the snapshot to avoid re-renders. */
export function useCloudWorkspace<T>(select: (state: CloudWorkspaceSnapshot) => T): T {
  return useSyncExternalStore(
    subscribe,
    () => select(snapshot),
    () => select(EMPTY)
  )
}

export function useIsCloudWorkspace(workspaceId: string | null | undefined): boolean {
  return useCloudWorkspace((state) => (workspaceId ? state.ids.has(workspaceId) : false))
}

export function cloudWorkspaceApi(): OrcaCloudWorkspaceApi | null {
  return typeof window !== 'undefined' ? (window.api?.orcaCloudWorkspace ?? null) : null
}

export function isCloudWorkspaceArchived(workspaceId: string): boolean {
  const entry = snapshot.status[workspaceId]?.status
  return entry?.state === 'archived' || Boolean(entry?.archive)
}

const inflight = new Map<string, Promise<void>>()

/** Fetches status once (coalesced); keeps the last good status visible on error. */
export function refreshCloudWorkspaceStatus(workspaceId: string): Promise<void> {
  const existing = inflight.get(workspaceId)
  if (existing) {
    return existing
  }
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return Promise.resolve()
  }
  updateCloudWorkspaceSnapshot((s) => ({
    status: {
      ...s.status,
      [workspaceId]: {
        status: s.status[workspaceId]?.status ?? null,
        error: s.status[workspaceId]?.error ?? null,
        fetchedAt: s.status[workspaceId]?.fetchedAt ?? null,
        loading: true
      }
    }
  }))
  const run = bridge
    .getStatus({ workspaceId })
    .then((result) => applyStatus(workspaceId, result))
    .catch((error: unknown) =>
      applyStatus(workspaceId, {
        ok: false,
        code: 'failed',
        message: error instanceof Error ? error.message : String(error)
      })
    )
    .finally(() => inflight.delete(workspaceId))
  inflight.set(workspaceId, run)
  return run
}

/** Mount-time refresh that skips a status read in the last `maxAgeMs` (sidebar rows remount often). */
export function refreshCloudWorkspaceStatusIfStale(
  workspaceId: string,
  maxAgeMs = 30_000
): Promise<void> {
  const fetchedAt = snapshot.status[workspaceId]?.fetchedAt
  if (fetchedAt != null && Date.now() - fetchedAt < maxAgeMs) {
    return Promise.resolve()
  }
  return refreshCloudWorkspaceStatus(workspaceId)
}

/**
 * Before any wake: is this workspace archived? Reads a fresh status when there is none, it is
 * older than `maxAgeMs`, or the last read failed — a cold start must never wake an archive.
 */
export async function isCloudWorkspaceArchivedFresh(
  workspaceId: string,
  maxAgeMs = 30_000
): Promise<boolean> {
  const entry = snapshot.status[workspaceId]
  if (!entry?.fetchedAt || entry.error || Date.now() - entry.fetchedAt >= maxAgeMs) {
    await refreshCloudWorkspaceStatus(workspaceId)
  }
  return isCloudWorkspaceArchived(workspaceId)
}

function applyStatus(workspaceId: string, result: CloudWorkspaceResult<HostedWorkspaceStatus>): void {
  updateCloudWorkspaceSnapshot((s) => {
    const previous = s.status[workspaceId]
    if (!result.ok && result.code === 'not_cloud') {
      const ids = new Set(s.ids)
      ids.delete(workspaceId)
      const status = { ...s.status }
      delete status[workspaceId]
      return { ids, status }
    }
    return {
      status: {
        ...s.status,
        [workspaceId]: result.ok
          ? { status: result.value, loading: false, error: null, fetchedAt: Date.now() }
          : {
              status: previous?.status ?? null,
              loading: false,
              error: result.message,
              fetchedAt: previous?.fetchedAt ?? null
            }
      }
    }
  })
}

const STARTUP_STATUS_CONCURRENCY = 4

/** Runs `work` over `items` with at most `limit` in flight. */
async function eachLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next++]!
      await work(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane))
}

export async function refreshCloudWorkspaceIds(): Promise<void> {
  const bridge = cloudWorkspaceApi()
  if (!bridge) {
    return
  }
  const ids = new Set(await bridge.listCloudWorkspaceIds().catch(() => [...snapshot.ids]))
  const same =
    snapshot.idsLoaded &&
    ids.size === snapshot.ids.size &&
    [...ids].every((id) => snapshot.ids.has(id))
  if (!same) {
    updateCloudWorkspaceSnapshot(() => ({ ids, idsLoaded: true }))
  }
  // A new id needs one status read so archived workspaces show as archived before anyone opens
  // them; capped so a large list doesn't fan out into dozens of VM probes at startup.
  await eachLimited(
    [...ids].filter((id) => !snapshot.status[id]),
    STARTUP_STATUS_CONCURRENCY,
    (id) => refreshCloudWorkspaceStatus(id)
  )
}

export function dismissCloudOom(workspaceId: string): void {
  const kills = snapshot.oom[workspaceId]?.oomKills
  if (kills === undefined) {
    return
  }
  updateCloudWorkspaceSnapshot((s) => ({ oomDismissed: { ...s.oomDismissed, [workspaceId]: kills } }))
}

function dropWake(workspaceId: string, only?: CloudWakeProgressEvent): void {
  updateCloudWorkspaceSnapshot((s) => {
    if (!s.wake[workspaceId] || (only && s.wake[workspaceId] !== only)) {
      return {}
    }
    const wake = { ...s.wake }
    delete wake[workspaceId]
    return { wake }
  })
}

/** "Dismiss" on the wake-failed card. */
export function dismissCloudWake(workspaceId: string): void {
  dropWake(workspaceId)
}

export function noteCloudWakeProgress(event: CloudWakeProgressEvent): void {
  // Keep the source the wake started with (later phases may not repeat it).
  const started = snapshot.wake[event.workspaceId]
  const next =
    started && event.phase !== 'waking' && started.startedAt === event.startedAt
      ? { ...event, source: started.source }
      : event
  updateCloudWorkspaceSnapshot((s) => ({
    ids: s.ids.has(event.workspaceId) ? s.ids : new Set([...s.ids, event.workspaceId]),
    wake: { ...s.wake, [event.workspaceId]: next }
  }))
  if (event.phase === 'ready') {
    // Settled: drop the entry once the status says what the VM is, so nothing keeps ticking.
    void refreshCloudWorkspaceStatus(event.workspaceId).finally(() =>
      dropWake(event.workspaceId, next)
    )
  } else if (event.phase === 'failed') {
    void refreshCloudWorkspaceStatus(event.workspaceId)
    setTimeout(() => dropWake(event.workspaceId, next), WAKE_FAILED_STALE_MS)
  }
}

export function noteCloudOom(event: CloudOomEvent): void {
  updateCloudWorkspaceSnapshot((s) => ({ oom: { ...s.oom, [event.workspaceId]: event } }))
}

/** Test/fixture seam: replace the whole snapshot. */
export function seedCloudWorkspaceSnapshot(next: Partial<CloudWorkspaceSnapshot>): void {
  inflight.clear()
  updateCloudWorkspaceSnapshot(() => ({ ...EMPTY, ...next }))
}

const STATUS_POLL_MS = 60_000
const IDS_POLL_MS = 30_000

/**
 * Starts the window's Orca Cloud listeners. Running workspaces refresh status every minute (CPU,
 * unresponsive); sleeping ones only re-read their state (no VM probe happens for them anyway).
 * Both cadences stretch while the window is unfocused and stop while hidden.
 */
export function installOrcaCloudWorkspaceStore(): () => void {
  const bridge = cloudWorkspaceApi()
  if (!bridge?.onWakeProgress || !bridge.onOom) {
    return () => {}
  }
  const disposeWake = bridge.onWakeProgress(noteCloudWakeProgress)
  const disposeOom = bridge.onOom(noteCloudOom)
  void refreshCloudWorkspaceIds()
  const stopIds = installWindowVisibilityInterval({
    run: () => void refreshCloudWorkspaceIds(),
    intervalMs: IDS_POLL_MS,
    slowWhileUnfocused: true
  })
  const stopStatus = installWindowVisibilityInterval({
    // Every cloud workspace: a sleeping one can be archived from the phone or another desktop.
    run: () =>
      void eachLimited([...snapshot.ids], STARTUP_STATUS_CONCURRENCY, (id) =>
        refreshCloudWorkspaceStatusIfStale(id, STATUS_POLL_MS / 2)
      ),
    intervalMs: STATUS_POLL_MS,
    slowWhileUnfocused: true
  })
  return () => {
    disposeWake()
    disposeOom()
    stopIds()
    stopStatus()
  }
}

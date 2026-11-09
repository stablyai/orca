// Window-side cache of Orca Cloud workspace lifecycle: which workspaces are cloud, their last
// status from the control plane, in-flight wakes and OOM notices. A tiny external store (not an
// app-store slice) so the hundreds of sidebar rows that are not cloud workspaces subscribe to nothing.
import { useSyncExternalStore } from 'react'
import type {
  CloudOomEvent,
  CloudWakeProgressEvent,
  CloudWorkspaceResult,
  OrcaCloudWorkspaceApi
} from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type {
  HostedArchivePullRequest,
  HostedWorkspaceStatus
} from '../../../../shared/hosted-sandbox/hosted-sandbox-wire'

export type CloudStatusEntry = {
  status: HostedWorkspaceStatus | null
  loading: boolean
  error: string | null
  fetchedAt: number | null
}

export type CloudWorkspaceSnapshot = {
  ids: ReadonlySet<string>
  status: Readonly<Record<string, CloudStatusEntry>>
  wake: Readonly<Record<string, CloudWakeProgressEvent>>
  oom: Readonly<Record<string, CloudOomEvent>>
  /** OOM kill count the user dismissed, per workspace. */
  oomDismissed: Readonly<Record<string, number>>
  /** Restart/archive/unarchive in flight, per workspace. */
  pending: Readonly<Record<string, 'restart' | 'archive' | 'unarchive'>>
}

const EMPTY: CloudWorkspaceSnapshot = {
  ids: new Set(),
  status: {},
  wake: {},
  oom: {},
  oomDismissed: {},
  pending: {}
}

let snapshot: CloudWorkspaceSnapshot = EMPTY
const listeners = new Set<() => void>()

function set(patch: (current: CloudWorkspaceSnapshot) => Partial<CloudWorkspaceSnapshot>): void {
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

function api(): OrcaCloudWorkspaceApi | null {
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
  const bridge = api()
  if (!bridge) {
    return Promise.resolve()
  }
  set((s) => ({
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

function applyStatus(workspaceId: string, result: CloudWorkspaceResult<HostedWorkspaceStatus>): void {
  set((s) => {
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

export async function refreshCloudWorkspaceIds(): Promise<void> {
  const bridge = api()
  if (!bridge) {
    return
  }
  const ids = new Set(await bridge.listCloudWorkspaceIds().catch(() => [] as string[]))
  const same = ids.size === snapshot.ids.size && [...ids].every((id) => snapshot.ids.has(id))
  if (!same) {
    set(() => ({ ids }))
  }
  // A new id needs one status read so archived workspaces show as archived before anyone opens them.
  for (const id of ids) {
    if (!snapshot.status[id]) {
      void refreshCloudWorkspaceStatus(id)
    }
  }
}

function withPending<T>(
  workspaceId: string,
  kind: 'restart' | 'archive' | 'unarchive',
  work: () => Promise<T>
): Promise<T> {
  set((s) => ({ pending: { ...s.pending, [workspaceId]: kind } }))
  return work().finally(() => {
    set((s) => {
      const pending = { ...s.pending }
      delete pending[workspaceId]
      return { pending }
    })
    void refreshCloudWorkspaceStatus(workspaceId)
  })
}

export function restartCloudWorkspace(workspaceId: string): Promise<CloudWorkspaceResult<null>> {
  const bridge = api()
  if (!bridge) {
    return Promise.resolve({ ok: false, code: 'not_cloud', message: 'Orca Cloud is unavailable.' })
  }
  return withPending(workspaceId, 'restart', async () => {
    const result = await bridge.restart({ workspaceId })
    if (result.ok) {
      dismissCloudOom(workspaceId)
    }
    return result
  })
}

/**
 * Archive = the ordinary Sleep (terminals and chats saved, VM stopped) and then archive with a
 * snapshot TTL. `sleep` is injected so this module does not pull the sidebar sleep flow into tests.
 */
export function archiveCloudWorkspace(
  workspaceId: string,
  deps: {
    sleep: (workspaceId: string) => Promise<unknown>
    pullRequests?: HostedArchivePullRequest[]
  }
): Promise<CloudWorkspaceResult<null>> {
  const bridge = api()
  if (!bridge) {
    return Promise.resolve({ ok: false, code: 'not_cloud', message: 'Orca Cloud is unavailable.' })
  }
  return withPending(workspaceId, 'archive', async () => {
    await deps.sleep(workspaceId)
    return bridge.archive({
      workspaceId,
      ...(deps.pullRequests?.length ? { pullRequests: deps.pullRequests } : {})
    })
  })
}

/** Unarchive resumes the disk on the control plane; `wake` then runs the ordinary open-and-wake path. */
export function unarchiveCloudWorkspace(
  workspaceId: string,
  deps: { wake: (workspaceId: string) => Promise<unknown> }
): Promise<CloudWorkspaceResult<null>> {
  const bridge = api()
  if (!bridge) {
    return Promise.resolve({ ok: false, code: 'not_cloud', message: 'Orca Cloud is unavailable.' })
  }
  return withPending(workspaceId, 'unarchive', async () => {
    const result = await bridge.unarchive({ workspaceId })
    if (result.ok) {
      // Clear the archived status first so the wake path is not short-circuited as archived.
      set((s) => {
        const status = { ...s.status }
        delete status[workspaceId]
        return { status }
      })
      await deps.wake(workspaceId)
    }
    return result
  })
}

export function dismissCloudOom(workspaceId: string): void {
  const kills = snapshot.oom[workspaceId]?.oomKills
  if (kills === undefined) {
    return
  }
  set((s) => ({ oomDismissed: { ...s.oomDismissed, [workspaceId]: kills } }))
}

export function noteCloudWakeProgress(event: CloudWakeProgressEvent): void {
  set((s) => ({
    ids: s.ids.has(event.workspaceId) ? s.ids : new Set([...s.ids, event.workspaceId]),
    wake: { ...s.wake, [event.workspaceId]: event }
  }))
  if (event.phase === 'ready' || event.phase === 'failed') {
    void refreshCloudWorkspaceStatus(event.workspaceId)
  }
}

export function noteCloudOom(event: CloudOomEvent): void {
  set((s) => ({ oom: { ...s.oom, [event.workspaceId]: event } }))
}

/** Test/fixture seam: replace the whole snapshot. */
export function seedCloudWorkspaceSnapshot(next: Partial<CloudWorkspaceSnapshot>): void {
  set(() => ({ ...EMPTY, ...next }))
}

const STATUS_POLL_MS = 60_000
const IDS_POLL_MS = 30_000

/**
 * Starts the window's Orca Cloud listeners. Running workspaces refresh status every minute (CPU,
 * unresponsive); sleeping ones are not probed (the control plane would not wake them anyway).
 */
export function installOrcaCloudWorkspaceStore(): () => void {
  const bridge = api()
  if (!bridge?.onWakeProgress || !bridge.onOom) {
    return () => {}
  }
  const disposeWake = bridge.onWakeProgress(noteCloudWakeProgress)
  const disposeOom = bridge.onOom(noteCloudOom)
  void refreshCloudWorkspaceIds()
  const idsTimer = setInterval(() => void refreshCloudWorkspaceIds(), IDS_POLL_MS)
  const statusTimer = setInterval(() => {
    for (const id of snapshot.ids) {
      const state = snapshot.status[id]?.status?.state
      if (state === 'ready' || state === 'unresponsive' || state === 'waking') {
        void refreshCloudWorkspaceStatus(id)
      }
    }
  }, STATUS_POLL_MS)
  return () => {
    disposeWake()
    disposeOom()
    clearInterval(idsTimer)
    clearInterval(statusTimer)
  }
}

// The window's view of cloud → this computer sync: one entry per workspace, filled on demand and
// kept current by main's change events (one listener for the whole window).
import { useEffect, useSyncExternalStore } from 'react'
import type { CloudSyncApi, CloudSyncView } from '../../../../shared/cloud-sync/cloud-sync-contract'

const views = new Map<string, CloudSyncView>()
const listeners = new Set<() => void>()
const requested = new Set<string>()
let unsubscribe: (() => void) | null = null

function api(): CloudSyncApi | null {
  return typeof window !== 'undefined' ? (window.api?.cloudSync ?? null) : null
}

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

function put(view: CloudSyncView | null): void {
  if (view) {
    views.set(view.workspaceId, view)
    notify()
  }
}

function ensureSubscribed(): void {
  const bridge = api()
  if (unsubscribe || !bridge) {
    return
  }
  unsubscribe = bridge.onChanged(put)
}

function load(workspaceId: string): void {
  const bridge = api()
  if (!bridge || requested.has(workspaceId)) {
    return
  }
  requested.add(workspaceId)
  void bridge
    .getState(workspaceId)
    .then(put)
    .catch(() => requested.delete(workspaceId))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Null until main answers, and in builds without the bridge (web, older preloads). */
export function useCloudSync(workspaceId: string): CloudSyncView | null {
  useEffect(() => {
    ensureSubscribed()
    load(workspaceId)
  }, [workspaceId])
  return useSyncExternalStore(subscribe, () => views.get(workspaceId) ?? null)
}

export async function setCloudSyncChoice(
  workspaceId: string,
  patch: { context?: boolean }
): Promise<void> {
  const bridge = api()
  const current = views.get(workspaceId)
  if (current) {
    // Optimistic: the switch moves at once; main's answer (or change event) settles it.
    put({ ...current, choice: { ...current.choice, ...patch } })
  }
  put((await bridge?.setChoice({ workspaceId, ...patch })) ?? null)
}

export function openCloudSyncFolder(workspaceId: string): Promise<{ ok: boolean }> {
  return api()?.openFolder(workspaceId) ?? Promise.resolve({ ok: false })
}

export function retryCloudSync(workspaceId: string): Promise<void> {
  return api()?.retry(workspaceId) ?? Promise.resolve()
}

export function cloudSyncRemovalPreview(
  workspaceId: string
): Promise<{ hasLocalCopy: boolean; editedHere: number }> {
  return (
    api()?.removalPreview(workspaceId) ?? Promise.resolve({ hasLocalCopy: false, editedHere: 0 })
  )
}

/** Fixtures and tests: seed a view without main. */
export function seedCloudSyncView(view: CloudSyncView): void {
  requested.add(view.workspaceId)
  put(view)
}

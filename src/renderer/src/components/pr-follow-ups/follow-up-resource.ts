import { useSyncExternalStore } from 'react'
import type { FollowUpSnapshot } from '../../../../shared/pr-follow-ups/contracts'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'

let snapshot: FollowUpSnapshot = { available: false, workspaces: {} }
const listeners = new Set<() => void>()
let release: (() => void) | undefined
let releaseNotices: (() => void) | undefined
let generation = 0
let subscribing: number | undefined
let reading = false
let dirty = false

async function refresh(): Promise<void> {
  dirty = true
  if (reading) {
    return
  }
  reading = true
  const mine = generation
  try {
    while (dirty && mine === generation) {
      dirty = false
      const next = await callRuntimeRpc<FollowUpSnapshot>({ kind: 'local' }, 'prFollowUps.get', {})
      if (mine !== generation) {
        return
      }
      for (const [id, workspace] of Object.entries(next.workspaces)) {
        if (JSON.stringify(workspace) === JSON.stringify(snapshot.workspaces[id])) {
          next.workspaces[id] = snapshot.workspaces[id]
        }
      }
      snapshot = next
      if (next.available) {
        subscribeChanges()
      } else {
        release?.()
        release = undefined
      }
      for (const listener of listeners) {
        listener()
      }
    }
  } catch (error) {
    console.warn('[pr-follow-ups] could not read follow-ups', error)
  } finally {
    reading = false
    if (dirty && listeners.size) {
      void refresh()
    }
  }
}

function subscribeChanges(): void {
  if (
    releaseNotices ||
    release ||
    subscribing === generation ||
    !listeners.size ||
    !window.api?.runtime?.subscribe
  ) {
    return
  }
  const mine = generation
  subscribing = mine
  void window.api.runtime
    .subscribe(
      { method: 'runtime.clientEvents.subscribe', params: { prFollowUpsOnly: true } },
      (response) => {
        if (!response.ok || mine !== generation) {
          return
        }
        const event = response.result as { type?: string }
        if (event.type === 'ready' || event.type === 'prFollowUpsChanged' || event.type === 'end') {
          void refresh()
        }
      }
    )
    .then((handle) => {
      if (mine !== generation || !snapshot.available) {
        handle.unsubscribe()
      } else {
        release = handle.unsubscribe
      }
    })
    .catch(console.warn)
    .finally(() => {
      if (subscribing === mine) {
        subscribing = undefined
      }
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1) {
    generation += 1
    // Passive window delivery also observes source installation without a client-event stream.
    releaseNotices = window.api?.runtime?.onPrFollowUpsChanged?.(() => {
      void refresh()
    })
    void refresh()
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      generation += 1
      release?.()
      release = undefined
      releaseNotices?.()
      releaseNotices = undefined
    }
  }
}

export function usePrFollowUpsAvailable(): boolean {
  return useSyncExternalStore(subscribe, () => snapshot.available)
}

export function usePrFollowUpWorkspace(worktreeId: string) {
  return useSyncExternalStore(subscribe, () =>
    snapshot.available ? (snapshot.workspaces[worktreeId] ?? null) : null
  )
}

export function usePrFollowUpFixing(worktreeId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => snapshot.available && Boolean(snapshot.workspaces[worktreeId]?.fixing)
  )
}

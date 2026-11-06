import { useSyncExternalStore } from 'react'
import type { FollowUpSnapshot } from '../../../../shared/pr-follow-ups/contracts'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'

let snapshot: FollowUpSnapshot = { available: false, workspaces: {} }
const listeners = new Set<() => void>()
let release: (() => void) | undefined
let generation = 0
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
      snapshot = next
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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && window.api?.runtime?.subscribe) {
    const mine = ++generation
    void window.api.runtime
      .subscribe({ method: 'runtime.clientEvents.subscribe', params: {} }, (response) => {
        if (!response.ok) {
          return
        }
        const event = response.result as { type?: string }
        if (event.type === 'ready' || event.type === 'prFollowUpsChanged') {
          void refresh()
        }
      })
      .then((handle) => {
        if (mine !== generation) {
          handle.unsubscribe()
        } else {
          release = handle.unsubscribe
        }
      })
      .catch(console.warn)
    void refresh()
  }
  return () => {
    listeners.delete(listener)
    if (!listeners.size) {
      generation += 1
      release?.()
      release = undefined
    }
  }
}

export function usePrFollowUps(): FollowUpSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot)
}

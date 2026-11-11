import { useSyncExternalStore } from 'react'
import type { RemoteDesktopPageState } from '../../../../shared/hosted-sandbox/cloud-remote-desktop'

// Main's word on each remote desktop page (connecting, connected, paused, or no session on this
// computer). One IPC subscription for the window, installed on first use, so a state that arrives
// before the page's chrome mounts is not lost.
const states = new Map<string, RemoteDesktopPageState>()
const listeners = new Set<() => void>()
let installed = false

function install(): void {
  if (installed) {
    return
  }
  const on = typeof window !== 'undefined' ? window.api?.browser?.onRemoteDesktopState : undefined
  if (typeof on !== 'function') {
    return
  }
  installed = true
  on((state) => {
    states.set(state.browserPageId, state)
    for (const listener of listeners) {
      listener()
    }
  })
}

function subscribe(listener: () => void): () => void {
  install()
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getRemoteDesktopPageState(browserPageId: string): RemoteDesktopPageState | null {
  install()
  return states.get(browserPageId) ?? null
}

/** Null until main reports on the page (it does once the page loads). */
export function useRemoteDesktopPageState(browserPageId: string): RemoteDesktopPageState | null {
  return useSyncExternalStore(subscribe, () => states.get(browserPageId) ?? null)
}

export function setRemoteDesktopPageStateForTest(
  state: RemoteDesktopPageState | null,
  id = ''
): void {
  if (state) {
    states.set(state.browserPageId, state)
  } else {
    states.delete(id)
  }
  for (const listener of listeners) {
    listener()
  }
}

import { useSyncExternalStore } from 'react'
import type { AgentUpdatesState } from '../../../../shared/agent-updates/agent-update-types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

// Why: main owns runs and checks; this mirrors its pushes so a window reload resumes the same view.
let state: AgentUpdatesState = { rows: [], checking: false, checkedAt: null }
let version = 0
const listeners = new Set<() => void>()

function setState(next: AgentUpdatesState): void {
  state = next
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function getSnapshot(): AgentUpdatesState {
  return state
}

export function useAgentUpdates(): AgentUpdatesState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Pulls the current state and follows main's pushes; a paired web client has no agent-updates API. */
export function startAgentUpdatesSync(): () => void {
  const api = window.api?.agentUpdates
  if (!api) {
    return () => {}
  }
  const unsubscribe = api.onState(setState)
  const pull = (): void => {
    const versionAtRequest = version
    void api.refresh().then(
      (next) => {
        // A push that landed first is newer than this reply.
        if (version === versionAtRequest) {
          setState(next)
        }
      },
      () => {}
    )
  }
  // Why: with no icon showing nothing else asks main to re-check; its TTL keeps these pulls cheap.
  const pullWhenVisible = (): void => {
    if (document.visibilityState === 'visible') {
      pull()
    }
  }
  pull()
  window.addEventListener('focus', pull)
  document.addEventListener('visibilitychange', pullWhenVisible)
  return () => {
    unsubscribe()
    window.removeEventListener('focus', pull)
    document.removeEventListener('visibilitychange', pullWhenVisible)
  }
}

/** Re-checks when the list opens; pushes deliver the result. */
export function refreshAgentUpdates(): void {
  void window.api?.agentUpdates?.refresh().catch(() => {})
}

export function requestAgentUpdates(agents: TuiAgent[]): void {
  void window.api?.agentUpdates?.update({ agents }).catch(() => {})
}

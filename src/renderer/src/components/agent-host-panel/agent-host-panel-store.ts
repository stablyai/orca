// One "Agent accounts & secrets" panel for the whole app (spec §4 deep link). Callers name the host and,
// optionally, what to focus; the mounted panel resolves the rest from the store.
import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'

export type AgentHostPanelFocus = 'claude' | 'codex' | 'keys' | { secret: string }

export type AgentHostPanelRequest = {
  hostId: ExecutionHostId
  focus?: AgentHostPanelFocus
  /** Orca Cloud: the workspace the caller is showing, when it knows it (the status panel does). */
  workspaceId?: string
}

let request: AgentHostPanelRequest | null = null
const listeners = new Set<() => void>()

function set(next: AgentHostPanelRequest | null): void {
  request = next
  for (const listener of listeners) {
    listener()
  }
}

export function openAgentHostPanel(next: AgentHostPanelRequest): void {
  set(next)
}

export function closeAgentHostPanel(): void {
  set(null)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useAgentHostPanelRequest(): AgentHostPanelRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => request,
    () => null
  )
}

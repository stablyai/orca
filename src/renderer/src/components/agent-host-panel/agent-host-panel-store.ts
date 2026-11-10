// One "Agent accounts & secrets" panel for the whole app (spec §4 deep link). Callers name the host and,
// optionally, what to focus; the mounted panel resolves the rest from the store.
import { useSyncExternalStore } from 'react'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { ExecutionHostHealth } from '../../../../shared/execution-host/execution-host-health'

export type AgentHostPanelFocus = 'claude' | 'codex' | 'keys' | { secret: string }

export type AgentHostPanelRequest = {
  hostId: ExecutionHostId
  focus?: AgentHostPanelFocus
  /** Orca Cloud: the workspace the caller is showing, when it knows it (the status panel does). */
  workspaceId?: string
  /** What the caller's host row shows (the sidebar's label and health), read once at open. */
  host?: { label: string; health: ExecutionHostHealth }
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

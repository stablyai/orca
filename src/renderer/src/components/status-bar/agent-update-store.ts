import { useEffect, useSyncExternalStore } from 'react'
import type { AgentUpdatesState } from '../../../../shared/agent-updates/agent-update-types'
import { AGENT_UPDATES_RUNTIME_CAPABILITY } from '../../../../shared/agent-updates/agent-updates-runtime-capability'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { installWindowVisibilityInterval } from '../../lib/window-visibility-interval'
import { callRuntimeRpc } from '../../runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '../../runtime/rpc/compatibility/runtime-capability-proof'

/** A server pushes nothing, so its state is re-read this often while it can change. */
const REMOTE_POLL_INTERVAL_MS = 2_000
const EMPTY: AgentUpdatesState = { rows: [], checking: false, checkedAt: null }

type AgentUpdatesTransport = {
  /** Null when the host cannot report agent updates. */
  refresh(): Promise<AgentUpdatesState | null>
  getState(): Promise<AgentUpdatesState>
  /** Null when the new state arrives as a push instead. */
  update(agents: TuiAgent[]): Promise<AgentUpdatesState | null>
  subscribe(listener: (state: AgentUpdatesState) => void): () => void
}

// Why keyed: each host owns its own agents and runs, so one host's view must never show for another.
const states = new Map<string, AgentUpdatesState>()
const versions = new Map<string, number>()
const listeners = new Set<() => void>()

function ownerKey(owner: RuntimeClientTarget): string {
  return owner.kind === 'environment' ? `environment:${owner.environmentId}` : 'local'
}

function setState(key: string, next: AgentUpdatesState): void {
  states.set(key, next)
  versions.set(key, (versions.get(key) ?? 0) + 1)
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Why: main owns local runs and pushes them; a paired web client has no agent-updates API.
function localTransport(): AgentUpdatesTransport | null {
  const api = window.api?.agentUpdates
  if (!api) {
    return null
  }
  return {
    refresh: () => api.refresh(),
    getState: () => api.getState(),
    update: (agents) => api.update({ agents }).then(() => null),
    subscribe: (listener) => api.onState(listener)
  }
}

// Why: the server runs checks and updates on its own machine; an older server has no such methods.
function remoteTransport(
  target: Extract<RuntimeClientTarget, { kind: 'environment' }>
): AgentUpdatesTransport {
  const call = (method: string, params?: { agents: TuiAgent[] }) =>
    callRuntimeRpc<AgentUpdatesState>(target, method, params)
  return {
    refresh: async () =>
      (await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        AGENT_UPDATES_RUNTIME_CAPABILITY
      ))
        ? call('agentUpdates.refresh')
        : null,
    getState: () => call('agentUpdates.getState'),
    update: (agents) => call('agentUpdates.update', { agents }),
    subscribe: () => () => {}
  }
}

function transportFor(owner: RuntimeClientTarget): AgentUpdatesTransport | null {
  return owner.kind === 'environment' ? remoteTransport(owner) : localTransport()
}

function pull(
  owner: RuntimeClientTarget,
  read: (transport: AgentUpdatesTransport) => Promise<AgentUpdatesState | null>
): void {
  const transport = transportFor(owner)
  if (!transport) {
    return
  }
  const key = ownerKey(owner)
  const versionAtRequest = versions.get(key)
  void read(transport).then(
    (next) => {
      // A push or newer reply that landed first is newer than this one.
      if (next && versions.get(key) === versionAtRequest) {
        setState(key, next)
      }
    },
    () => {}
  )
}

export function useAgentUpdates(owner: RuntimeClientTarget | null): AgentUpdatesState {
  const getSnapshot = (): AgentUpdatesState => (owner && states.get(ownerKey(owner))) || EMPTY
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Pulls the owner's state and follows its pushes; re-checks when the window regains focus. */
export function startAgentUpdatesSync(owner: RuntimeClientTarget): () => void {
  const transport = transportFor(owner)
  if (!transport) {
    return () => {}
  }
  const key = ownerKey(owner)
  const unsubscribe = transport.subscribe((next) => setState(key, next))
  // Why: with no icon showing nothing else asks the host to re-check; its TTL keeps these pulls cheap.
  const refresh = (): void => pull(owner, (current) => current.refresh())
  const refreshWhenVisible = (): void => {
    if (document.visibilityState === 'visible') {
      refresh()
    }
  }
  refresh()
  window.addEventListener('focus', refresh)
  document.addEventListener('visibilitychange', refreshWhenVisible)
  return () => {
    unsubscribe()
    window.removeEventListener('focus', refresh)
    document.removeEventListener('visibilitychange', refreshWhenVisible)
  }
}

/** Re-reads a server's state while it can change: the list is open, a check or a run is in progress. */
export function useRemoteAgentUpdatesPolling(
  owner: RuntimeClientTarget | null,
  open: boolean
): void {
  const state = useAgentUpdates(owner)
  const environmentId = owner?.kind === 'environment' ? owner.environmentId : null
  const changing = open || state.checking || state.rows.some((row) => row.run?.state === 'running')
  useEffect(() => {
    if (!environmentId || !changing) {
      return
    }
    const target: RuntimeClientTarget = { kind: 'environment', environmentId }
    return installWindowVisibilityInterval({
      run: () => pull(target, (current) => current.getState()),
      intervalMs: REMOTE_POLL_INTERVAL_MS
    })
  }, [environmentId, changing])
}

/** Re-checks when the list opens. */
export function refreshAgentUpdates(owner: RuntimeClientTarget): void {
  pull(owner, (transport) => transport.refresh())
}

export function requestAgentUpdates(owner: RuntimeClientTarget, agents: TuiAgent[]): void {
  const transport = transportFor(owner)
  const key = ownerKey(owner)
  void transport?.update(agents).then(
    (next) => {
      if (next) {
        setState(key, next)
      }
    },
    () => {}
  )
}

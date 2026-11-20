import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '@/store/index'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { subscribeRuntimeEnvironment } from '@/runtime/rpc/environment-revisions/runtime-environment-pairing-refresh'
import {
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { ZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-snapshot'
import { normalizeRemoteZotzAgentQueueSnapshot } from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-remote-snapshot'
import {
  ZOTZ_AGENT_QUEUE_CONTROL_RUNTIME_CAPABILITY,
  ZOTZ_AGENT_QUEUE_RUNTIME_CAPABILITY
} from '../../../../../shared/zotz/agent-queue/zotz-agent-queue-runtime-capability'

// Each paired server's memory queue, keyed by its host id; absent while it is unreachable or too old to publish one.
let hostQueues: ReadonlyMap<ExecutionHostId, ZotzAgentQueueSnapshot> = new Map()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function setHostQueue(hostId: ExecutionHostId, snapshot: ZotzAgentQueueSnapshot | null): void {
  const next = new Map(hostQueues)
  if (snapshot) {
    next.set(hostId, snapshot)
  } else if (!next.delete(hostId)) {
    return
  }
  hostQueues = next
  listeners.forEach((listener) => listener())
}

export function useZotzHostAgentQueues(): ReadonlyMap<ExecutionHostId, ZotzAgentQueueSnapshot> {
  return useSyncExternalStore(subscribe, () => hostQueues)
}

export function useZotzHostAgentQueue(
  hostId: ExecutionHostId | null | undefined
): ZotzAgentQueueSnapshot | null {
  return useSyncExternalStore(subscribe, () => (hostId ? (hostQueues.get(hostId) ?? null) : null))
}

function hostDeclares(
  state: ReturnType<typeof useAppStore.getState>,
  environmentId: string,
  capability: string
): boolean {
  const status = lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(environmentId))
  return status?.capabilities?.includes(capability) === true
}

function hostPublishesQueue(
  state: ReturnType<typeof useAppStore.getState>,
  environmentId: string
): boolean {
  return hostDeclares(state, environmentId, ZOTZ_AGENT_QUEUE_RUNTIME_CAPABILITY)
}

/** True when the server can also cancel or force a queued launch, so its buttons may show here. */
export function selectZotzHostQueueControllable(
  state: ReturnType<typeof useAppStore.getState>,
  environmentId: string
): boolean {
  return hostDeclares(state, environmentId, ZOTZ_AGENT_QUEUE_CONTROL_RUNTIME_CAPABILITY)
}

export function useZotzHostQueueControllable(environmentId: string | null): boolean {
  return useAppStore(
    (state) => environmentId !== null && selectZotzHostQueueControllable(state, environmentId)
  )
}

/** Follow the memory queue of every paired server that publishes one; hosts without the capability are skipped silently. */
export function installZotzHostAgentQueueSync(): () => void {
  const active = new Map<string, { unsubscribe: () => void }>()
  const starting = new Set<string>()
  let disposed = false

  const stopHost = (environmentId: string): void => {
    active.get(environmentId)?.unsubscribe()
    active.delete(environmentId)
    setHostQueue(toRuntimeExecutionHostId(environmentId), null)
  }

  const startHost = (environmentId: string): void => {
    if (active.has(environmentId) || starting.has(environmentId)) {
      return
    }
    starting.add(environmentId)
    const hostId = toRuntimeExecutionHostId(environmentId)
    subscribeRuntimeEnvironment(
      {
        selector: environmentId,
        method: 'zotz.agentQueue.subscribe',
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: getRuntimeEnvironmentRevision(environmentId)
      },
      {
        onResponse: (response) => {
          if (response.ok === false) {
            return
          }
          const snapshot = normalizeRemoteZotzAgentQueueSnapshot(response.result)
          if (snapshot) {
            setHostQueue(hostId, snapshot)
          }
        },
        onError: () => {},
        onClose: () => {
          active.delete(environmentId)
          setHostQueue(hostId, null)
        }
      }
    ).then(
      (handle) => {
        starting.delete(environmentId)
        const state = useAppStore.getState()
        if (
          disposed ||
          state.removedRuntimeEnvironmentIds.has(environmentId) ||
          !hostPublishesQueue(state, environmentId)
        ) {
          handle.unsubscribe()
          return
        }
        active.set(environmentId, handle)
      },
      () => {
        starting.delete(environmentId)
      }
    )
  }

  const sync = (state: ReturnType<typeof useAppStore.getState>): void => {
    for (const environmentId of active.keys()) {
      if (
        state.removedRuntimeEnvironmentIds.has(environmentId) ||
        !hostPublishesQueue(state, environmentId)
      ) {
        stopHost(environmentId)
      }
    }
    for (const environmentId of state.runtimeStatusByEnvironmentId.keys()) {
      if (
        !state.removedRuntimeEnvironmentIds.has(environmentId) &&
        hostPublishesQueue(state, environmentId)
      ) {
        startHost(environmentId)
      }
    }
  }

  sync(useAppStore.getState())
  const stopStore = useAppStore.subscribe((state, previous) => {
    if (
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId ||
      state.removedRuntimeEnvironmentIds !== previous.removedRuntimeEnvironmentIds
    ) {
      sync(state)
    }
  })
  return () => {
    disposed = true
    stopStore()
    for (const environmentId of active.keys()) {
      stopHost(environmentId)
    }
  }
}

export function useZotzHostAgentQueueSync(): void {
  useEffect(() => installZotzHostAgentQueueSync(), [])
}

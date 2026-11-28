import { useEffect, useMemo, useRef } from 'react'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { callRuntimeRpc } from '../rpc/calls/runtime-rpc-call'
import { useAppStore } from '@/store'
import { useRuntimeSessionMirrorEnvironmentKeys } from '../web-session-tabs-sync/subscriptions/use-runtime-session-mirror-environment-key'

const POLL_MS = 5_000

type Store = {
  getState: () => {
    setRuntimeAgentOrchestrationByPaneKey: (
      entries: Record<string, AgentStatusOrchestrationContext>,
      producerHost?: string
    ) => void
  }
}
type Call = (
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options?: { background?: boolean }
) => Promise<unknown>

/** Reads a paired host's parent/child map and files it under that host, beside the local one. */
export async function pullRemoteOrchestration(
  store: Store,
  environmentId: string,
  call: Call = callRuntimeRpc
): Promise<void> {
  let result: { byPaneKey?: Record<string, AgentStatusOrchestrationContext> }
  try {
    result = (await call(
      { kind: 'environment', environmentId },
      'status.agentOrchestration',
      undefined,
      { background: true }
    )) as typeof result
  } catch {
    // An older host has no such method and a dropped link retries on the next tick; keep what we have.
    return
  }
  store
    .getState()
    .setRuntimeAgentOrchestrationByPaneKey(
      result?.byPaneKey ?? {},
      toRuntimeExecutionHostId(environmentId)
    )
}

/** Keeps every reachable paired host's orchestration map current, for the desktop client and the web client. */
export function useRemoteOrchestrationSync(): void {
  const { environmentKey } = useRuntimeSessionMirrorEnvironmentKeys()
  const environmentIds = useMemo(
    () => (environmentKey ? environmentKey.split('\u0000').map((t) => t.split('\u0001')[0]) : []),
    [environmentKey]
  )
  const known = useRef<Set<string>>(new Set())
  useEffect(() => {
    // A host that left must not leave its rows nested under parents we can no longer see.
    for (const gone of [...known.current].filter((id) => !environmentIds.includes(id))) {
      useAppStore
        .getState()
        .setRuntimeAgentOrchestrationByPaneKey({}, toRuntimeExecutionHostId(gone))
    }
    known.current = new Set(environmentIds)
    const tick = (): void => {
      for (const environmentId of environmentIds) {
        void pullRemoteOrchestration(useAppStore, environmentId)
      }
    }
    tick()
    const timer = environmentIds.length > 0 ? setInterval(tick, POLL_MS) : undefined
    return () => {
      if (timer) {
        clearInterval(timer)
      }
    }
  }, [environmentIds])
}

// A remote host's Dispatches live on it, so its worker lineage is read from it and stored under it.

import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status/contracts/agent-status-types'
import { parseOrchestration } from '../../../../shared/agent-status/store/agent-status-store-status-codec'
import {
  AGENT_ACTIVITY_ORCHESTRATION_MAX_CONTEXTS,
  AGENT_ACTIVITY_ORCHESTRATION_METHOD
} from '../../../../shared/rpc-contract/agent-activity/agent-activity-params'

type HostRead = {
  reading: boolean
  queued: boolean
  unsupported: boolean
  retryTimer: ReturnType<typeof setTimeout> | null
}

// A failed read retries twice, still in the background; the next host event or reconnect reads again after.
const RETRY_DELAYS_MS = [1_000, 4_000]
const MAX_PANE_KEY_LENGTH = 512

const reads = new Map<string, HostRead>()

/** Re-read one host's contexts, coalescing overlaps; `reconnected` re-asks a host that lacked the method. */
export function refreshRemoteAgentOrchestration(
  environmentId: string,
  options?: { reconnected?: boolean }
): void {
  let read = reads.get(environmentId)
  if (!read) {
    read = { reading: false, queued: false, unsupported: false, retryTimer: null }
    reads.set(environmentId, read)
  }
  if (options?.reconnected) {
    read.unsupported = false
  }
  if (read.unsupported) {
    return
  }
  if (read.reading) {
    read.queued = true
    return
  }
  clearRetry(read)
  void readHost(environmentId, read, 0)
}

function clearRetry(read: HostRead): void {
  if (read.retryTimer) {
    clearTimeout(read.retryTimer)
    read.retryTimer = null
  }
}

function hostRemoved(environmentId: string): boolean {
  return useAppStore.getState().removedRuntimeEnvironmentIds?.has(environmentId) === true
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Only well-formed contexts under bounded keys, at most the host-side cap; a malformed reply reads as none. */
export function parseRemoteAgentOrchestration(
  result: unknown
): Record<string, AgentStatusOrchestrationContext> {
  const contexts: Record<string, AgentStatusOrchestrationContext> = Object.fromEntries([])
  const raw = isRecord(result) ? result.contexts : undefined
  if (!isRecord(raw)) {
    return contexts
  }
  let count = 0
  for (const [key, value] of Object.entries(raw)) {
    if (count >= AGENT_ACTIVITY_ORCHESTRATION_MAX_CONTEXTS) {
      break
    }
    const context = key.length <= MAX_PANE_KEY_LENGTH ? parseOrchestration(value) : null
    if (context) {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: parseOrchestration checked every field of the context type.
      contexts[key] = context as AgentStatusOrchestrationContext
      count += 1
    }
  }
  return contexts
}

async function readHost(environmentId: string, read: HostRead, attempt: number): Promise<void> {
  if (hostRemoved(environmentId)) {
    reads.delete(environmentId)
    return
  }
  read.reading = true
  let failed = false
  try {
    const result = await callRuntimeRpc<unknown>(
      { kind: 'environment', environmentId },
      AGENT_ACTIVITY_ORCHESTRATION_METHOD,
      undefined,
      // Event-driven bookkeeping: never wake an idle host or count as user activity.
      { suppressFeatureInteraction: true, background: true }
    )
    // A host removed mid-read must not leave its lineage behind.
    if (!hostRemoved(environmentId)) {
      useAppStore
        .getState()
        .setRuntimeAgentOrchestrationByPaneKey(
          parseRemoteAgentOrchestration(result),
          toRuntimeExecutionHostId(environmentId)
        )
    }
  } catch (error) {
    // An older host has no such method; its rows stay flat as before rather than being asked again.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      read.unsupported = true
    } else {
      failed = true
    }
  } finally {
    read.reading = false
  }
  if (hostRemoved(environmentId)) {
    reads.delete(environmentId)
    return
  }
  if (read.unsupported) {
    return
  }
  if (read.queued) {
    read.queued = false
    void readHost(environmentId, read, 0)
    return
  }
  const delay = failed ? RETRY_DELAYS_MS[attempt] : undefined
  if (delay !== undefined) {
    read.retryTimer = setTimeout(() => {
      read.retryTimer = null
      void readHost(environmentId, read, attempt + 1)
    }, delay)
  }
}

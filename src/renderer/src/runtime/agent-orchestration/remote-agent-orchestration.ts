// A remote host keeps its own Dispatch records; this window's graph reply carries only this computer's,
// so each host's worker lineage is read from that host and stored under it as producer.

import { useAppStore } from '@/store'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import {
  AGENT_ACTIVITY_ORCHESTRATION_METHOD,
  type AgentActivityOrchestrationResult
} from '../../../../shared/rpc-contract/agent-activity/agent-activity-params'

type HostRead = { reading: boolean; queued: boolean; unsupported: boolean }

const reads = new Map<string, HostRead>()

/** Re-read one host's contexts; overlapping requests coalesce into one trailing read.
 *  `reconnected` asks again of a host that lacked the method, as it may have been updated. */
export function refreshRemoteAgentOrchestration(
  environmentId: string,
  options?: { reconnected?: boolean }
): void {
  let read = reads.get(environmentId)
  if (!read) {
    read = { reading: false, queued: false, unsupported: false }
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
  void readHost(environmentId, read)
}

async function readHost(environmentId: string, read: HostRead): Promise<void> {
  read.reading = true
  try {
    const result = await callRuntimeRpc<AgentActivityOrchestrationResult>(
      { kind: 'environment', environmentId },
      AGENT_ACTIVITY_ORCHESTRATION_METHOD,
      undefined,
      // Event-driven bookkeeping: never wake an idle host or count as user activity.
      { suppressFeatureInteraction: true, background: true }
    )
    useAppStore
      .getState()
      .setRuntimeAgentOrchestrationByPaneKey(
        result?.contexts ?? {},
        toRuntimeExecutionHostId(environmentId)
      )
  } catch (error) {
    // An older host has no such method; its rows stay flat as before rather than being asked again.
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      read.unsupported = true
    }
  } finally {
    read.reading = false
    if (read.queued && !read.unsupported) {
      read.queued = false
      void readHost(environmentId, read)
    }
  }
}

import { emitAutomationsChangedWindowEvent } from '@/components/automations/events/automations-changed-window-event'
import { emitWorkspaceCleanupRunFinishedWindowEvent } from '@/components/workspace-cleanup/events/workspace-cleanup-run-finished-window-event'
import type { RuntimeClientEvent } from '../../../../../shared/remote-runtime/session-graph/runtime-client-events'
import { emitPeerMailReturnedWindowEvent } from '@/lib/peer-mail-returned-window-event'
import { emitMcpServersChangedWindowEvent } from '@/lib/mcp-servers-changed-window-event'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { refreshRemoteAgentOrchestration } from '@/runtime/agent-orchestration/remote-agent-orchestration'

/** Re-emits a server's events that renderer pages listen for as window events; true when handled. */
export function emitRuntimeClientWindowEvent(
  environmentId: string,
  event: RuntimeClientEvent
): boolean {
  if (event.type === 'automationsChanged') {
    // Why: without the environment the subscriber cannot attribute the changed authority.
    emitAutomationsChangedWindowEvent({
      environmentId,
      ...(event.selector ? { selector: event.selector } : {}),
      ...(event.reason ? { reason: event.reason } : {})
    })
    return true
  }
  if (event.type === 'peerMailReturned') {
    emitPeerMailReturnedWindowEvent(toRuntimeExecutionHostId(environmentId))
    return true
  }
  if (event.type === 'mcpServersChanged') {
    emitMcpServersChangedWindowEvent(toRuntimeExecutionHostId(environmentId))
    return true
  }
  if (event.type === 'agentOrchestrationChanged') {
    refreshRemoteAgentOrchestration(environmentId)
    return true
  }
  if (event.type === 'workspaceCleanupRunFinished') {
    emitWorkspaceCleanupRunFinishedWindowEvent({ environmentId, run: event.run })
    return true
  }
  return false
}

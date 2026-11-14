import { emitAutomationsChangedWindowEvent } from '@/components/automations/events/automations-changed-window-event'
import { emitWorkspaceCleanupRunFinishedWindowEvent } from '@/components/workspace-cleanup/events/workspace-cleanup-run-finished-window-event'
import type { RuntimeClientEvent } from '../../../../shared/runtime-client-events'

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
  if (event.type === 'workspaceCleanupRunFinished') {
    emitWorkspaceCleanupRunFinishedWindowEvent({ environmentId, run: event.run })
    return true
  }
  return false
}

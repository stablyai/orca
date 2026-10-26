import {
  getStructuredLaunchStateBySessionId,
  detachStructuredLaunchStateIfCurrent
} from './agent-session/launch/structured-agent-session-launch-registry'
import {
  hasStructuredAgentLaunchCancellationTombstonePersisted,
  prepareStructuredAgentLaunchCancellationPersistence
} from './agent-session/launch/structured-agent-session-launch-persistence'
import { prepareStructuredAgentLaunchCancellation } from './launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'
import { prepareStructuredAgentLocalLaunchCancellation } from './structured-agent-session-local-launch-cancel'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
export function prepareStructuredAgentSessionLaunchCancellation(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
) {
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const captured = state?.intent.worktreeId === worktreeId ? state : undefined
  const host = captured?.intent.executionHostId ?? executionHostId
  const local = ORCA_LAYOUT_OWNER_IS_MAIN && host === LOCAL_EXECUTION_HOST_ID
  const alreadyCancelled = hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
  if (!captured && alreadyCancelled) {
    return { install: () => {}, effects: [] }
  }
  const persistence = local
    ? prepareStructuredAgentLaunchCancellationPersistence(sessionId, host, false)
    : prepareStructuredAgentLaunchCancellation(sessionId, host, alreadyCancelled, captured?.promise)
  const localCancellation = local
    ? prepareStructuredAgentLocalLaunchCancellation(worktreeId, sessionId)
    : undefined
  return {
    install: () => {
      if (captured && getStructuredLaunchStateBySessionId(sessionId) === captured) {
        captured.cancelled = true
        captured.callers.outcome = 'cancelled'
        detachStructuredLaunchStateIfCurrent(captured)
      }
      persistence.install()
      localCancellation?.install()
    },
    effects: [...persistence.effects, ...(localCancellation?.effects ?? [])]
  }
}

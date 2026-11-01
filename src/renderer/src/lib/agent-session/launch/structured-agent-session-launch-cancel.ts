import { retireStructuredAgentSessionReadOwner } from '@/components/native-chat/structured-agent-session-read-owner-registry'
import { structuredAgentSessionTargetForHost } from '@/runtime/structured-agent-session-owner'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../../../shared/execution-host'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../../shared/layout-owner-switch'
import { markStructuredAgentLaunchCancellation } from '../../launch-cancel-tombstones-compat/structured-agent-session-launch-cancellation'
import { cancelStructuredAgentLaunchOnLocalHost } from '../../structured-agent-session-local-launch-cancel'
import { forgetStructuredSessionSelection } from '../../structured-agent-session-selection-controller'
import { hasStructuredAgentLaunchCancellationTombstonePersisted } from './structured-agent-session-launch-persistence'
import {
  removeStructuredLaunchSlot,
  type StructuredLaunchSlotOwner
} from './structured-agent-session-launch-slot'
import {
  deleteStructuredLaunchStateIfCurrent,
  getPersistedStructuredAgentLaunchRecord,
  getStructuredLaunchStateBySessionId,
  notifyStructuredLaunchListeners
} from './structured-agent-session-launch-registry'

function markStructuredAgentSessionLaunchCancelledInternal(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId,
  owner: StructuredLaunchSlotOwner | undefined
): boolean {
  const alreadyCancelled = hasStructuredAgentLaunchCancellationTombstonePersisted(sessionId)
  const state = getStructuredLaunchStateBySessionId(sessionId)
  const record = getPersistedStructuredAgentLaunchRecord(sessionId)
  const surfaceAddress = state?.intent.surfaceAddress ?? record?.surfaceAddress
  const matchingState = state?.intent.worktreeId === worktreeId ? state : undefined
  const host = matchingState?.intent.executionHostId ?? record?.executionHostId ?? executionHostId
  const target = matchingState?.intent.target ?? structuredAgentSessionTargetForHost(host)
  if (state?.intent.worktreeId === worktreeId) {
    // The launch's own owner outranks the caller's: it is the host the create was sent to.
    if (ORCA_LAYOUT_OWNER_IS_MAIN && state.intent.executionHostId === LOCAL_EXECUTION_HOST_ID) {
      cancelStructuredAgentLaunchOnLocalHost(worktreeId, sessionId)
    } else {
      markStructuredAgentLaunchCancellation(
        sessionId,
        state.intent.executionHostId,
        alreadyCancelled,
        state.promise
      )
    }
    state.cancelled = true
    forgetStructuredSessionSelection(sessionId, state.intent.target)
    state.callers.outcome = 'cancelled'
    // Tombstones remain durable authority; drop in-memory dead promises so bulk closes cannot retain them all session.
    deleteStructuredLaunchStateIfCurrent(state)
  } else if (
    ORCA_LAYOUT_OWNER_IS_MAIN &&
    !alreadyCancelled &&
    executionHostId === LOCAL_EXECUTION_HOST_ID
  ) {
    cancelStructuredAgentLaunchOnLocalHost(worktreeId, sessionId)
  } else if (!alreadyCancelled) {
    markStructuredAgentLaunchCancellation(sessionId, executionHostId, alreadyCancelled)
  }
  if ((!state || matchingState) && (!surfaceAddress || surfaceAddress.worktreeId === worktreeId)) {
    retireStructuredAgentSessionReadOwner(sessionId, target, host)
  }
  if (owner && surfaceAddress) {
    removeStructuredLaunchSlot(owner, worktreeId, sessionId)
  }
  if (!alreadyCancelled && owner) {
    notifyStructuredLaunchListeners()
  }
  return !alreadyCancelled
}

/** `executionHostId` owns the chat; a launch still in memory names its own. */
export function markStructuredAgentSessionLaunchCancelled(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId,
  owner: StructuredLaunchSlotOwner
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    executionHostId,
    owner
  )
}

/** Bulk workspace purges run inside a store updater; persist cancellation without notifying React. */
export function markStructuredAgentSessionLaunchCancelledSilently(
  worktreeId: string,
  sessionId: string,
  executionHostId: ExecutionHostId
): boolean {
  return markStructuredAgentSessionLaunchCancelledInternal(
    worktreeId,
    sessionId,
    executionHostId,
    undefined
  )
}

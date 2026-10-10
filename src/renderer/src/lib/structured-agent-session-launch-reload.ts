import {
  restoreStructuredAgentSessionLaunchIntent,
  StructuredAgentSessionOwnerUnresolvedError,
  type StructuredAgentSessionLaunchIntent
} from './launch-structured-agent-session'
import {
  createStructuredLaunchCallerGroup,
  type StructuredLaunchCallerGroup
} from './structured-agent-session-launch-callers'
import {
  getPersistedStructuredAgentLaunchRecord,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'

export function restorePersistedStructuredLaunchState(
  worktreeId: string,
  sessionId: string
): StructuredLaunchState | undefined {
  const record = getPersistedStructuredAgentLaunchRecord(sessionId)
  if (!record) {
    return undefined
  }
  let intent: StructuredAgentSessionLaunchIntent
  try {
    intent = restoreStructuredAgentSessionLaunchIntent({
      worktreeId,
      executionHostId: record.executionHostId,
      sessionId: record.sessionId,
      agent: record.agent,
      clientOperationId: record.clientOperationId,
      payloadFingerprint: record.payloadFingerprint,
      expectedRuntimeFence: record.expectedRuntimeFence,
      ...(record.resumeFrom ? { resumeFrom: record.resumeFrom } : {}),
      ...(record.seedOptions ? { seedOptions: record.seedOptions } : {}),
      ...(record.firstMessage ? { firstMessage: record.firstMessage } : {}),
      ...(record.options ? { options: record.options } : {}),
      ...(record.createMessageSupport === undefined
        ? {}
        : { createMessageSupport: record.createMessageSupport })
    })
  } catch (error) {
    // A record naming a host no runtime serves cannot be retried anywhere.
    if (error instanceof StructuredAgentSessionOwnerUnresolvedError) {
      return undefined
    }
    throw error
  }
  // Only a Retry or re-check restarts a restored launch.
  const callers: StructuredLaunchCallerGroup = createStructuredLaunchCallerGroup({ kind: 'retry' })
  const state: StructuredLaunchState = {
    identity: structuredLaunchIdentity(worktreeId, record.agent, record.resumeFrom),
    intent,
    promptDelivery: 'draft',
    promise: Promise.resolve({ sessionId: record.sessionId, fence: 0 }),
    visibilityUnknown: record.lifecycle === 'visibility-unknown',
    cancelled: false,
    onVisibilityChanged: undefined,
    callers,
    selection: { seed: intent.seedOptions, held: {} }
  }
  callers.outcome = record.lifecycle === 'failed' ? 'failed' : 'unknown'
  callers.failedAt = record.failedAt
  setStructuredLaunchState(state)
  return state
}

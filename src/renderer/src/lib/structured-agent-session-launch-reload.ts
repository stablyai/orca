import { restoreStructuredAgentSessionLaunchIntent } from './launch-structured-agent-session'
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
  const intent = restoreStructuredAgentSessionLaunchIntent({
    worktreeId,
    sessionId: record.sessionId,
    agent: record.agent,
    clientOperationId: record.clientOperationId,
    payloadFingerprint: record.payloadFingerprint,
    expectedRuntimeFence: record.expectedRuntimeFence,
    ...(record.resumeFrom ? { resumeFrom: record.resumeFrom } : {})
  })
  const callers: StructuredLaunchCallerGroup = createStructuredLaunchCallerGroup()
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
  setStructuredLaunchState(state)
  return state
}

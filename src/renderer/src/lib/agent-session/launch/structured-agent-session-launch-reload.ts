import {
  findStructuredAgentSessionPendingSend,
  getStructuredAgentSessionPendingSends,
  publishStructuredAgentSessionSends
} from '@/components/native-chat/structured-agent-session-pending-sends'
import {
  restoreStructuredAgentSessionLaunchIntent,
  type StructuredAgentSessionLaunchIntent
} from '../../launch-structured-agent-session'
import { StructuredAgentSessionOwnerUnresolvedError } from '../../structured-agent-session-launch-errors'
import {
  createStructuredLaunchCallerGroup,
  type StructuredLaunchCallerGroup
} from '../../structured-agent-session-launch-callers'
import {
  getPersistedStructuredAgentLaunchRecord,
  setStructuredLaunchState,
  structuredLaunchIdentity,
  type StructuredLaunchState
} from './structured-agent-session-launch-registry'
import {
  initialStructuredLaunchSelection,
  structuredLaunchSelectionController
} from '../../structured-agent-session-launch-options'

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
      ...(record.optionsMode ? { optionsMode: record.optionsMode } : {}),
      ...(record.options ? { options: record.options } : {}),
      ...(record.explicitLaunchOptions
        ? { explicitLaunchOptions: record.explicitLaunchOptions }
        : {}),
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
  // Saved openings are passive correlation; reading them never resubmits their envelope.
  const callers: StructuredLaunchCallerGroup = createStructuredLaunchCallerGroup({ kind: 'retry' })
  const state: StructuredLaunchState = {
    identity: structuredLaunchIdentity(worktreeId, record.agent, record),
    intent: {
      ...intent,
      ...(record.surfaceAddress ? { surfaceAddress: record.surfaceAddress } : {})
    },
    promptDelivery: 'draft',
    promise: Promise.resolve({ sessionId: record.sessionId, fence: 0 }),
    visibilityUnknown: record.lifecycle !== 'failed',
    ...(record.firstMessage && record.lifecycle !== 'failed'
      ? { operationEnded: true as const }
      : {}),
    cancelled: false,
    onVisibilityChanged: undefined,
    callers,
    selection: initialStructuredLaunchSelection(intent)
  }
  callers.outcome = record.lifecycle === 'failed' ? 'failed' : 'unknown'
  callers.failedAt = record.failedAt
  structuredLaunchSelectionController(state)
  setStructuredLaunchState(state)
  if (
    record.firstMessage &&
    record.lifecycle !== 'failed' &&
    !findStructuredAgentSessionPendingSend(sessionId, record.firstMessage.clientMessageId)
  ) {
    publishStructuredAgentSessionSends(sessionId, {
      entries: [
        {
          sessionId,
          clientMessageId: record.firstMessage.clientMessageId,
          body: record.firstMessage.body,
          previewUris: [],
          queuedAt: Date.now(),
          phase: 'unconfirmed',
          issued: true,
          ...(record.options ? { options: record.options } : {})
        },
        ...getStructuredAgentSessionPendingSends(sessionId)
      ]
    })
  }
  return state
}

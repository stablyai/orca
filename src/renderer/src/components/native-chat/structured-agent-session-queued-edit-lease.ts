import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { startQueuedEditLease as startSharedQueuedEditLease } from '../../../../shared/queued-message-edit-lease'

export { QUEUED_EDIT_LEASE_RENEW_MS } from '../../../../shared/queued-message-edit-lease'
export type { QueuedEditLease } from '../../../../shared/queued-message-edit-lease'

export function startQueuedEditLease(input: {
  target: RuntimeClientTarget
  sessionId: string
  messageId: string
  editId: string
  expectedBodyFingerprint: string
}) {
  return startSharedQueuedEditLease({
    sessionId: input.sessionId,
    messageId: input.messageId,
    editId: input.editId,
    expectedBodyFingerprint: input.expectedBodyFingerprint,
    request: (params) =>
      callStructuredAgentSession(input.target, 'agentSession.queuedMessageEditHold', params)
  })
}

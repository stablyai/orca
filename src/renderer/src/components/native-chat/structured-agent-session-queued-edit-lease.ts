import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  startQueuedEditLease as startSharedQueuedEditLease,
  type QueuedEditLeaseLoss
} from '../../../../shared/queued-message-edit-lease'

export { QUEUED_EDIT_LEASE_RENEW_MS } from '../../../../shared/queued-message-edit-lease'
export type { QueuedEditLease } from '../../../../shared/queued-message-edit-lease'

export function startQueuedEditLease(input: {
  target: RuntimeClientTarget
  sessionId: string
  messageId: string
  editId: string
  expectedBodyFingerprint: string
  onLost: (loss: QueuedEditLeaseLoss) => void
}) {
  return startSharedQueuedEditLease({
    sessionId: input.sessionId,
    messageId: input.messageId,
    editId: input.editId,
    expectedBodyFingerprint: input.expectedBodyFingerprint,
    onLost: input.onLost,
    request: (params) =>
      callStructuredAgentSession(input.target, 'agentSession.queuedMessageEditHold', params)
  })
}

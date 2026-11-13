import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  startQueuedEditLease as startSharedQueuedEditLease,
  type QueuedEditLeaseLoss
} from '../../../../../../shared/queued-message-edit-lease'

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

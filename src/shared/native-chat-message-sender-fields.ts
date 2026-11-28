import type { AgentJournalMemorySave } from './agent-session/journal/agent-journal-bot-message-fields'
import type { AgentJournalRenderItem } from './agent-session/journal/agent-session-journal-types'
import { readAgentMessageSource } from './agent-session/journal/agent-session-message-source'
import { otherPersonTypistOf } from './agent-session/journal/agent-journal-typed-by'
import { readConnectorMessageAsker } from './connector-message-asker'
import { readTookOverNotice } from './native-chat/took-over-notice'
import type { NativeChatMessage } from './native-chat/native-chat-types'
import { readAutomationRunMessage } from './automations/automation-run-message'

/** Who sent a user-role message other than the person typing it here: another agent (`from`),
 *  someone Orca delivered for through a connector (`asker`), a bot automation's run
 *  (`automationRun`), or another person on their paired computer (`typedByOther`). Each is read
 *  from a host of any version, and only beside its origin. */
export function nativeChatMessageSenderFields(
  body: AgentJournalRenderItem['body'],
  role: NativeChatMessage['role']
): Pick<
  NativeChatMessage,
  'from' | 'asker' | 'typedByOther' | 'orcaNotice' | 'tookOver' | 'automationRun'
> {
  if (body.kind !== 'message' || role !== 'user') {
    return {}
  }
  // A malformed run draws as the message it always was.
  const automationRun =
    body.origin === 'automation-run' ? readAutomationRunMessage(body.automationRun) : undefined
  if (automationRun) {
    return { automationRun }
  }
  if (body.origin === 'bot-created' || body.origin === 'card-answer') {
    return { orcaNotice: body.origin }
  }
  if (body.origin === 'memory-save') {
    const memorySave = readMemorySave(body.memorySave)
    return { orcaNotice: 'memory-save', ...(memorySave ? { memorySave } : {}) }
  }
  if (body.origin === 'took-over') {
    const tookOver = readTookOverNotice(body.tookOver)
    return { orcaNotice: 'took-over', ...(tookOver ? { tookOver } : {}) }
  }
  const from = readAgentMessageSource(body.from)
  const asker = body.origin === 'connector' ? readConnectorMessageAsker(body.asker) : undefined
  const typedByOther = from || asker ? undefined : otherPersonTypistOf(body.typedBy)
  return {
    ...(from ? { from } : {}),
    ...(asker ? { asker } : {}),
    ...(typedByOther ? { typedByOther } : {})
  }
}

/** A stored reading as the divider may draw it; anything malformed draws as no number. */
function readMemorySave(value: unknown): AgentJournalMemorySave | undefined {
  if (typeof value !== 'object' || value === null || !('percent' in value)) {
    return undefined
  }
  const { percent } = value
  const estimated = 'estimated' in value && value.estimated === true
  return typeof percent === 'number' && Number.isFinite(percent)
    ? { percent, estimated }
    : undefined
}

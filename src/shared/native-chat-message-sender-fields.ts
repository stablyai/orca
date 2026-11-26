import type { AgentJournalRenderItem } from './agent-session/journal/agent-session-journal-types'
import { readAgentMessageSource } from './agent-session/journal/agent-session-message-source'
import { personTypistOf } from './agent-session/journal/agent-journal-typed-by'
import { readConnectorMessageAsker } from './connector-message-asker'
import { readTookOverNotice } from './native-chat/took-over-notice'
import type { NativeChatMessage } from './native-chat/native-chat-types'
import { readAutomationRunMessage } from './automations/automation-run-message'

/** Who sent a user-role message: another agent (`from`), someone Orca delivered for through a
 *  connector (`asker`), a bot automation's run (`automationRun`), or a person on a paired computer
 *  (`typist`, drawn only when not the viewer). Each is read from a host of any version, and only
 *  beside its origin. */
export function nativeChatMessageSenderFields(
  body: AgentJournalRenderItem['body'],
  role: NativeChatMessage['role']
): Pick<
  NativeChatMessage,
  'from' | 'asker' | 'typist' | 'orcaNotice' | 'tookOver' | 'automationRun'
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
  if (body.origin === 'took-over') {
    const tookOver = readTookOverNotice(body.tookOver)
    return { orcaNotice: 'took-over', ...(tookOver ? { tookOver } : {}) }
  }
  const from = readAgentMessageSource(body.from)
  const asker = body.origin === 'connector' ? readConnectorMessageAsker(body.asker) : undefined
  const typist = from || asker ? undefined : personTypistOf(body.typedBy)
  return {
    ...(from ? { from } : {}),
    ...(asker ? { asker } : {}),
    ...(typist ? { typist } : {})
  }
}

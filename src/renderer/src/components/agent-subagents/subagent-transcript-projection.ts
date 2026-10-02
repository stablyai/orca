import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { translate } from '@/i18n/i18n'

/** Hide Codex bootstrap records and surface only parent-triggered tasks plus the
 *  subagent's actual activity and answers. */
export function projectSubagentTranscript(
  messages: readonly NativeChatMessage[],
  parentIdentity: string,
  showIdentity = true
): NativeChatMessage[] {
  const firstTurn = messages.findIndex(
    (message) =>
      message.subagentEvent?.kind === 'turn-boundary' && message.subagentEvent.triggerTurn
  )
  if (firstTurn === -1) {
    return messages.filter((message) => !message.subagentEvent)
  }

  const projected: NativeChatMessage[] = []
  let awaitingTask = false
  for (const message of messages.slice(firstTurn)) {
    const event = message.subagentEvent
    if (event?.kind === 'turn-boundary') {
      awaitingTask = event.triggerTurn
      continue
    }
    if (event?.kind === 'agent-message') {
      if (awaitingTask) {
        projected.push({
          ...message,
          role: 'user',
          blocks: [
            {
              type: 'text',
              text: showIdentity
                ? translate('agentSubagents.taskFromIdentity', 'Task from @{{identity}}', {
                    identity: parentIdentity
                  })
                : translate('agentSubagents.taskFromParent', 'Task from parent agent')
            }
          ],
          subagentEvent: { kind: 'task', parentIdentity }
        })
      }
      awaitingTask = false
      continue
    }
    projected.push(message)
  }
  return projected
}

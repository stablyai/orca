import type { NativeChatMessage } from '../../../../shared/native-chat-types'

/** Hide Codex bootstrap records and surface only parent-triggered tasks plus the
 *  subagent's actual activity and answers. */
export function projectSubagentTranscript(
  messages: readonly NativeChatMessage[],
  parentIdentity: string
): NativeChatMessage[] {
  const firstTurn = messages.findIndex(
    (message) =>
      message.subagentEvent?.kind === 'turn-boundary' && message.subagentEvent.triggerTurn
  )
  if (firstTurn < 0) {
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
          blocks: [{ type: 'text', text: `Task from @${parentIdentity}` }],
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

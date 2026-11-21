import { remoteMemberKey } from './bot-group-mentions'
import type { BotGroupMessage } from './bot-group-schema'

// What a group member's room context takes from its remote members' questions and answers.

/** This post's question reached that remote member's computer, so it has seen the room to here. */
export function remoteMemberAsked(message: BotGroupMessage, remoteKey: string | null): boolean {
  return (message.remoteAsks ?? []).some(
    (ask) => remoteMemberKey(ask) === remoteKey && ask.state === 'sent'
  )
}

/** Other remote members' answers to this post, named with their computer, as context lines. */
export function remoteAnswerLines(message: BotGroupMessage, remoteKey: string | null) {
  return (message.remoteAsks ?? []).flatMap((ask) => {
    const id = remoteMemberKey(ask)
    const name = `${ask.name} (${ask.computer})`
    return ask.reply?.kind === 'answer' && id !== remoteKey
      ? [{ author: { kind: 'bot' as const, id, name }, text: ask.reply.text.slice(-16_000) }]
      : []
  })
}

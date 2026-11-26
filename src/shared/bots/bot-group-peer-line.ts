import type { BotGroupMessage } from './bot-group-schema'

/** What a bot's room line says: who asked or told whom, whose reply the asker read, or a plain follow-up. */
export type BotGroupPeerLine =
  | { kind: 'asked' | 'told'; from: string; to: string }
  | { kind: 'read'; reader: string; peer: string }
  | { kind: 'followed'; bot: string }
  | { kind: 'items'; bot: string }
  | { kind: 'paused'; count: number }

/** A row with no stored requester or replier (older ones too) is a plain follow-up: the room's
 *  loaded history cannot say which peer, if any, it answered. */
export function botGroupPeerLine(message: BotGroupMessage): BotGroupPeerLine {
  if (message.pausedAfter) {
    return { kind: 'paused', count: message.pausedAfter }
  }
  const name =
    (message.author.kind === 'bot' ? message.author.name : null) ?? message.turns[0]?.botName ?? ''
  if (message.requester) {
    const kind = message.requester.told ? 'told' : 'asked'
    return {
      kind,
      from: message.requester.name,
      to: message.turns[0]?.botName ?? message.remoteAsks?.[0]?.name ?? name
    }
  }
  if (message.fromItems) {
    return { kind: 'items', bot: name }
  }
  return message.answeredBy
    ? {
        kind: 'read',
        reader: message.continuation ? (message.turns[0]?.botName ?? name) : name,
        peer: message.answeredBy.name
      }
    : { kind: 'followed', bot: name }
}

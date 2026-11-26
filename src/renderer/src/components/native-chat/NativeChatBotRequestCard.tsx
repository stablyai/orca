// The row Orca leaves in the owner's chat when its bot asks or hands work to another bot: who it went
// to, which kind, and its answer or why it wasn't sent, read from Orca's record as that bot's chat changes.
import { cn } from '@/lib/class-names'
import { callBotRpc } from '@/lib/bot-hosts'
import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { openBotHomeTab, useBots } from '@/lib/bot-catalog'
import { openBotSession } from '../bots/bot-session-open'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { Bot } from '../../../../shared/bot-types'
import type {
  BotRequestCard,
  BotRequestCardReading
} from '../../../../shared/bots/bot-request-card'
import { foldBotRequestMail } from './bot-request-folded-mail'
import {
  BOT_REQUEST_CARD_COPY,
  botRequestCardView,
  type BotRequestCardSay
} from '../../../../shared/bots/bot-request-card-view'
import type { BotCardCopyValues } from '../../../../shared/native-chat/bot-cards/bot-card-copy'
import { NativeChatEventRow } from './messages/events/NativeChatEventRow'
import { NativeChatClientAskRequestCard } from './NativeChatClientAskRequestCard'
import {
  NATIVE_CHAT_INLINE_NAME,
  NATIVE_CHAT_ROW_SHARE
} from './messages/events/native-chat-inline-chip'

const COPY = BOT_REQUEST_CARD_COPY
const PIECES: Record<keyof typeof COPY, (values?: BotCardCopyValues) => string> = {
  notSentTo: () => translate('components.native-chat.botRequest.notSentTo', COPY.notSentTo),
  asked: () => translate('components.native-chat.botRequest.asked', COPY.asked),
  handedTo: () => translate('components.native-chat.botRequest.handedTo', COPY.handedTo),
  paused: (values) => translate('components.native-chat.botRequest.paused', COPY.paused, values),
  botsOff: () => translate('components.native-chat.botRequest.botsOff', COPY.botsOff),
  couldNotTake: (values) =>
    translate('components.native-chat.botRequest.couldNotTake', COPY.couldNotTake, values)
}
const say: BotRequestCardSay = (id, values) => PIECES[id](values)

/** Nothing to read for a request Orca refused to send. */
function useOutcome(
  bot: Bot,
  messageId: string | undefined,
  status: string
): BotRequestCardReading {
  const [reading, setReading] = useState<BotRequestCardReading>({
    outcome: null,
    answer: null,
    mailIds: []
  })
  const settled = reading.outcome === 'answered' && reading.answer !== null
  const { hostId } = bot
  // An answer or a dropped request lands as that bot's chat changes, so each change rereads it.
  useEffect(() => {
    if (settled || !messageId) {
      return
    }
    let live = true
    void callBotRpc<BotRequestCardReading>({ hostId }, 'bots.request.outcome', {
      messageId
    })
      .then((result) => {
        foldBotRequestMail(result.mailIds ?? [])
        if (live) {
          setReading(result)
        }
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [hostId, messageId, status, bot.paused, bot.chatSessionId, settled])
  return reading
}

const REQUEST_ICON = <Send aria-hidden className="size-3.5" />

export function NativeChatBotRequestCard({
  card,
  cardId,
  timestamp,
  fallback
}: {
  card: BotRequestCard
  /** The transcript item carrying the card, so its fold outlives the row. */
  cardId: string
  timestamp: number | null
  /** The host's line, for a bot this window doesn't list. */
  fallback: string
}): React.JSX.Element {
  useTranslation()
  const bot = useBots().find((entry) => entry.id === card.toBotId)
  // Asked of an agent on a computer paired to this chat's host: read from that host, not a bot's.
  if (card.client) {
    return (
      <NativeChatClientAskRequestCard
        card={card}
        client={card.client}
        cardId={cardId}
        timestamp={timestamp}
      />
    )
  }
  if (!bot) {
    return (
      <NativeChatEventRow
        icon={REQUEST_ICON}
        badge={card.messageId ? null : 'failed'}
        timestamp={timestamp}
      >
        {fallback}
      </NativeChatEventRow>
    )
  }
  return <KnownBotRequestCard bot={bot} card={card} cardId={cardId} timestamp={timestamp} />
}

function KnownBotRequestCard({
  bot,
  card,
  cardId,
  timestamp
}: {
  bot: Bot
  card: BotRequestCard
  cardId: string
  timestamp: number | null
}): React.JSX.Element {
  const status = useWorktreeActivityStatus(folderWorkspaceKey(bot.folderWorkspaceId))
  const reading = useOutcome(bot, card.messageId, status)
  // The chat the request went to, unless that is Home now; Home until it's known.
  const { chatId } = reading
  const openChat = () =>
    chatId && chatId !== bot.chatSessionId ? openBotSession(bot, chatId) : void openBotHomeTab(bot)
  const view = botRequestCardView(card, reading, status, say)
  const subject = view.sent ? card.subject : ''
  return (
    <NativeChatEventRow
      icon={REQUEST_ICON}
      badge={view.badge}
      label={[`${view.heading} ${bot.name}`, subject].filter(Boolean).join(' · ')}
      timestamp={timestamp}
      disclosureKey={cardId ? `bot-request:${cardId}` : undefined}
      details={
        view.sent ? (
          view.answer ? (
            <p className="whitespace-pre-wrap">{view.answer}</p>
          ) : null
        ) : (
          <>
            <p>{view.line}</p>
            {card.subject ? <p className="text-chat-foreground-faint">{card.subject}</p> : null}
          </>
        )
      }
    >
      <span className="shrink-0">{view.heading}</span>
      {view.sent ? (
        <button
          type="button"
          onClick={openChat}
          title={bot.name}
          className={cn(
            NATIVE_CHAT_INLINE_NAME,
            'rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
          )}
        >
          {bot.name}
        </button>
      ) : (
        <span className={NATIVE_CHAT_INLINE_NAME} title={bot.name}>
          {bot.name}
        </span>
      )}
      {subject ? (
        <span className={NATIVE_CHAT_ROW_SHARE} title={subject}>
          · {subject}
        </span>
      ) : null}
    </NativeChatEventRow>
  )
}

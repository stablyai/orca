// The card Orca leaves in the owner's chat when its bot asks or hands work to another bot: who it went
// to, which kind, how it stands and its answer, read from Orca's record as that bot's chat changes.
import { callBotRpc } from '@/lib/bot-hosts'
import { useEffect, useId, useState } from 'react'
import { ArrowUpRight, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AgentStateDot } from '@/components/agent/status/AgentStateDot'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/class-names'
import { openBotHomeTab, useBots } from '@/lib/bot-catalog'
import { openBotSession } from '../bots/bot-session-open'
import { useWorktreeActivityStatus } from '@/components/sidebar/workspace-card/activity/use-worktree-activity-status'
import { BotAvatar } from '../bots/BotAvatar'
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
import { NativeChatCardAvatar } from './NativeChatCardFrame'
import { useNativeChatDisclosure } from './messages/disclosure/native-chat-disclosure-store'
import { NativeChatExpandable } from './messages/disclosure/NativeChatExpandable'
import { NativeChatCopyButton } from './messages/actions/NativeChatCopyButton'
import { NativeChatMessageTimestamp } from './messages/rows/NativeChatMessageTimestamp'

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
  if (!bot) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
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
  const disclosure = useNativeChatDisclosure(cardId ? `bot-request:${cardId}` : undefined, false)
  const labelId = useId()
  const bodyId = useId()
  // The chat the request went to, unless that is Home now; Home until it's known.
  const { chatId } = reading
  const openChat = () =>
    chatId && chatId !== bot.chatSessionId ? openBotSession(bot, chatId) : void openBotHomeTab(bot)
  const view = botRequestCardView(card, reading, status, say)
  const { dot, copyText } = view
  const expandable = view.answer !== null
  return (
    <div className="group @container w-full rounded-xl border border-border bg-card text-sm text-card-foreground">
      <div
        className="relative flex min-w-0 items-center gap-2 px-3 py-1.5"
        data-state={disclosure.open ? 'open' : 'closed'}
      >
        {expandable ? (
          <button
            type="button"
            aria-labelledby={labelId}
            aria-controls={bodyId}
            aria-expanded={disclosure.open}
            onClick={() => disclosure.setOpen(!disclosure.open)}
            className="absolute inset-0 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        ) : null}
        <div className="pointer-events-none">
          <NativeChatCardAvatar compact>
            <BotAvatar bot={bot} className="size-full rounded-full border-0" />
            {dot ? (
              // Flex square: the chat line box would stretch a shrink-wrapped badge into a pill.
              <span className="absolute -right-0.5 -bottom-0.5 flex size-3.5 items-center justify-center rounded-full border border-border bg-card">
                <AgentStateDot state={dot} size="md" />
              </span>
            ) : null}
          </NativeChatCardAvatar>
        </div>
        <span
          id={labelId}
          className="pointer-events-none max-w-1/3 shrink-0 truncate text-xs text-muted-foreground"
        >
          {view.heading}
        </span>
        <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 [&_button]:pointer-events-auto">
          {view.sent ? (
            <Button
              type="button"
              variant="ghost"
              size="inlineChip"
              className="min-w-0 max-w-fit shrink-0"
              title={bot.name}
              onClick={openChat}
            >
              <span className="min-w-0 truncate">{bot.name}</span>
              <ArrowUpRight className="size-3" aria-hidden />
            </Button>
          ) : (
            <span className="min-w-0 shrink-0 truncate px-1.5" title={bot.name}>
              {bot.name}
            </span>
          )}
          <span className="min-w-0 truncate text-muted-foreground">{view.line}</span>
        </div>
        {copyText ? (
          <NativeChatCopyButton
            text={copyText}
            className="relative transition-opacity can-hover:pointer-events-none can-hover:opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 [.group:has(:focus-visible)_&]:pointer-events-auto [.group:has(:focus-visible)_&]:opacity-100"
          />
        ) : null}
        <div className={cn('pointer-events-none shrink-0', expandable && 'hidden @sm:block')}>
          <NativeChatMessageTimestamp timestamp={timestamp} className="text-muted-foreground" />
        </div>
        {expandable ? (
          <ChevronDown
            aria-hidden
            className={cn(
              'pointer-events-none size-3.5 shrink-0 text-muted-foreground',
              disclosure.open && 'rotate-180'
            )}
          />
        ) : null}
      </div>
      <NativeChatExpandable open={expandable && disclosure.open}>
        <div id={bodyId} className="space-y-2 px-3 pb-3">
          <p className="whitespace-pre-wrap text-chat-foreground">{view.answer}</p>
          <NativeChatMessageTimestamp
            timestamp={timestamp}
            className="text-muted-foreground @sm:hidden"
          />
        </div>
      </NativeChatExpandable>
    </div>
  )
}

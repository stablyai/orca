// The bot-request card for an ask to an agent on a computer paired to the chat's host: the same row,
// naming that computer, its state read from the chat's host as its mail lands.
import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { onBotsChanged } from '@/lib/bots-changed-window-event'
import { useOwnInstallation } from '@/components/bots/use-paired-server-client-mentions'
import { useHeldPairedServerAsk } from '@/components/bots/use-paired-server-asks'
import { BotMentionHostText } from '@/components/bots/BotMentionHostBadge'
import { useNativeChatVisualOwner } from './media/visuals/native-chat-visual-owner'
import { foldBotRequestMail } from './bot-request-folded-mail'
import { NativeChatEventRow } from './messages/events/NativeChatEventRow'
import {
  NATIVE_CHAT_INLINE_NAME,
  NATIVE_CHAT_ROW_SHARE
} from './messages/events/native-chat-inline-chip'
import type {
  BotRequestCard,
  BotRequestCardReading
} from '../../../../shared/bots/bot-request-card'

const NOT_READ: BotRequestCardReading = { outcome: null, answer: null, mailIds: [] }

/** Read from the chat's host while it is still open; each bot change there may be its answer. */
function useClientAskReading(messageId: string | undefined): BotRequestCardReading {
  const target = useNativeChatVisualOwner()?.target ?? null
  const [reading, setReading] = useState<BotRequestCardReading>(NOT_READ)
  const settled = reading.outcome !== null
  useEffect(() => {
    if (!target || !messageId || settled) {
      return
    }
    let live = true
    const read = () =>
      void callRuntimeRpc<BotRequestCardReading>(target, 'bots.request.outcome', {
        messageId,
        onClient: true
      })
        .then((result) => {
          foldBotRequestMail(result.mailIds ?? [])
          if (live) {
            setReading(result)
          }
        })
        .catch(() => {})
    read()
    const stop = onBotsChanged(read, getRuntimeTargetHostId(target))
    return () => {
      live = false
      stop()
    }
  }, [target, messageId, settled])
  return reading
}

export function NativeChatClientAskRequestCard({
  card,
  client,
  cardId,
  timestamp
}: {
  card: BotRequestCard
  client: NonNullable<BotRequestCard['client']>
  cardId: string
  timestamp: number | null
}): React.JSX.Element {
  const t = useTranslate()
  const reading = useClientAskReading(card.messageId)
  const here = useOwnInstallation() === client.installationId
  const computer = here
    ? t('bots.groups.thisComputer', 'This computer')
    : client.computer || t('components.native-chat.clientAsk.pairedComputer', 'Paired computer')
  const sent = Boolean(card.messageId)
  const held = useHeldPairedServerAsk(card.messageId, here && reading.outcome === null)
  const heading = !sent
    ? t('components.native-chat.botRequest.notSentTo', 'Not sent to')
    : card.purpose === 'question'
      ? t('components.native-chat.botRequest.asked', 'Asked')
      : t('components.native-chat.botRequest.handedTo', 'Handed to')
  const state = !sent
    ? t('components.native-chat.clientAsk.notConnected', 'Wasn’t connected')
    : reading.outcome === 'dropped'
      ? // A notice that it went unanswered shows as its details instead.
        reading.answer
        ? null
        : t('components.native-chat.clientAsk.declined', 'Declined')
      : reading.outcome === null
        ? here
          ? held
            ? t('components.native-chat.clientAsk.waitingForYou', 'Waiting for you')
            : null
          : t(
              'components.native-chat.clientAsk.waitingOn',
              'Waiting for approval on {{computer}}',
              {
                computer: client.computer
              }
            )
        : null
  return (
    <NativeChatEventRow
      icon={<Send aria-hidden className="size-3.5" />}
      badge={!sent || reading.outcome === 'dropped' ? 'failed' : reading.outcome ? null : 'running'}
      label={[`${heading} ${card.toBotName}`, card.subject, state].filter(Boolean).join(' · ')}
      timestamp={timestamp}
      disclosureKey={cardId ? `bot-request:${cardId}` : undefined}
      details={
        reading.answer ? (
          <p className="whitespace-pre-wrap">{reading.answer}</p>
        ) : card.subject ? (
          <p className="text-chat-foreground-faint">{card.subject}</p>
        ) : null
      }
    >
      <span className="shrink-0">{heading}</span>
      <span className={NATIVE_CHAT_INLINE_NAME} title={card.toBotName}>
        {card.toBotName}
      </span>
      <BotMentionHostText label={computer} />
      {card.subject ? (
        <span className={NATIVE_CHAT_ROW_SHARE} title={card.subject}>
          · {card.subject}
        </span>
      ) : null}
      {state ? <span className="shrink-0 text-chat-foreground-faint">· {state}</span> : null}
    </NativeChatEventRow>
  )
}

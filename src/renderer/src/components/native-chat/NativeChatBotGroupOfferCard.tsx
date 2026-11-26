// The card a bot shows with `orca bot group create --offer`: a group chat it proposes. Nothing is created
// until the owner presses Create group; the card then reads Created, from the groups there are.
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { useBots } from '@/lib/bot-catalog'
import { openBotGroup } from '@/lib/bot-group-catalog'
import { refreshBotHostGroups, useBotGroups } from '@/lib/bot-group-list'
import { callBotGroupRpc } from '@/lib/bot-group-rpc'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import {
  BOT_GROUP_OFFER_COPY,
  botGroupOfferCreated,
  botGroupOfferView,
  type BotGroupOffer,
  type BotGroupOfferSay
} from '../../../../shared/bots/bot-group-offer'
import type { BotCardCopyValues } from '../../../../shared/native-chat/bot-cards/bot-card-copy'
import { BotGroupFaceCluster } from '../bots/BotGroupFaceCluster'
import { botErrorText } from '../bots/bot-presentation'
import { NativeChatCardFrame, NativeChatCardStatus } from './NativeChatCardFrame'
import { NativeChatOfferActions, useNativeChatOffer } from './NativeChatOfferActions'

const COPY = BOT_GROUP_OFFER_COPY
const PIECES: Record<keyof typeof COPY, (t: Translate, values?: BotCardCopyValues) => string> = {
  heading: (t) => t('components.native-chat.botGroupOffer.heading', COPY.heading),
  created: (t) => t('components.native-chat.botGroupOffer.created', COPY.created),
  create: (t) => t('components.native-chat.botGroupOffer.create', COPY.create),
  open: (t) => t('components.native-chat.botGroupOffer.open', COPY.open),
  members: (t, values) => t('components.native-chat.botGroupOffer.members', COPY.members, values),
  memberGone: (t, values) =>
    t('components.native-chat.botGroupOffer.memberGone', COPY.memberGone, values)
}

function OfferCard({
  offer,
  proposer,
  bots,
  messageId
}: {
  offer: BotGroupOffer
  proposer: Bot
  bots: readonly Bot[]
  messageId: string
}): React.JSX.Element {
  const t = useTranslate()
  const say: BotGroupOfferSay = (id, values) => PIECES[id](t, values)
  const answering = useNativeChatOffer(proposer.id, messageId)
  const [creating, setCreating] = useState(false)
  const groups = useBotGroups()
  const hostBots = bots.filter((bot) => bot.hostId === proposer.hostId)
  const created = botGroupOfferCreated(
    offer,
    groups.filter((group) => group.hostId === proposer.hostId)
  )
  const view = botGroupOfferView(offer, created, hostBots, say)
  const members = offer.members.flatMap(
    (member) => hostBots.find((bot) => bot.id === member.botId) ?? []
  )
  const open = (group: BotGroup): void => {
    void openBotGroup(group).catch((error: unknown) => toast.error(botErrorText(error)))
  }

  const create = (): void => {
    setCreating(true)
    // The host makes one group per card, however many windows press.
    void callBotGroupRpc<{ group: BotGroup }>(proposer, 'bots.groups.create', {
      name: offer.name,
      botIds: offer.members.map((member) => member.botId),
      fromOffer: { botId: proposer.id, offerId: offer.offerId }
    })
      .then(async ({ group }) => {
        await refreshBotHostGroups(proposer.hostId)
        open(group)
      })
      .catch((error: unknown) => toast.error(botErrorText(error)))
      .finally(() => setCreating(false))
  }

  return (
    <NativeChatCardFrame
      avatar={<BotGroupFaceCluster members={members} compact />}
      heading={say('heading')}
      status={
        created ? (
          <NativeChatCardStatus tone="success">{say('created')}</NativeChatCardStatus>
        ) : null
      }
      title={view.title}
      footer={
        created ? (
          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => open(created)}>
              {say('open')}
            </Button>
          </div>
        ) : (
          <NativeChatOfferActions offer={answering}>
            <Button
              type="button"
              size="sm"
              disabled={creating || view.blocked !== null}
              onClick={create}
            >
              {say('create')}
            </Button>
          </NativeChatOfferActions>
        )
      }
    >
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{view.members}</p>
      {view.purpose ? (
        <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">{view.purpose}</p>
      ) : null}
      {view.blocked ? (
        <p className="text-xs text-status-warning-text [overflow-wrap:anywhere]">{view.blocked}</p>
      ) : null}
    </NativeChatCardFrame>
  )
}

export function NativeChatBotGroupOfferCard({
  offer,
  messageId,
  fallback
}: {
  offer: BotGroupOffer
  messageId: string
  /** The host's line, for a bot this window doesn't list. */
  fallback: string
}): React.JSX.Element {
  const bots = useBots()
  const proposer = bots.find((entry) => entry.id === offer.botId)
  if (!proposer) {
    return <p className="text-sm text-chat-foreground-faint">{fallback}</p>
  }
  return <OfferCard offer={offer} proposer={proposer} bots={bots} messageId={messageId} />
}

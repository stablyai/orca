import { defineFixture } from '../../component-fixtures/component-fixture'
import { stubBots } from '../../component-fixtures/fixture-bots'
import { mascotAvatar, type BotMascotId } from '../../../../shared/bot-avatar'
import type { Bot } from '../../../../shared/bot-types'
import type { BotGroup } from '../../../../shared/bots/bot-group'
import type { BotGroupOffer } from '../../../../shared/bots/bot-group-offer'
import { NativeChatBotGroupOfferCard } from './NativeChatBotGroupOfferCard'

function bot(id: string, name: string, mascot: BotMascotId): Bot {
  return {
    id,
    name,
    hostId: 'local',
    folder: id,
    folderWorkspaceId: `fw-${id}`,
    agent: 'claude',
    avatar: mascotAvatar(mascot),
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1
  }
}

const superBot = bot('super', 'Super bot', 'A1')
const notes = bot('notes', 'Release notes', 'H1')
const review = bot('review', 'PR review', 'K2')

const crew: BotGroupOffer = {
  botId: superBot.id,
  offerId: 'offer-crew',
  name: 'Launch crew',
  members: [
    { botId: superBot.id, name: superBot.name },
    { botId: notes.id, name: notes.name },
    { botId: review.id, name: review.name }
  ],
  purpose: 'Gets 1.5 out: notes drafted, open pull requests reviewed.',
  offeredAt: 1000
}

const made: BotGroup = {
  id: 'crew',
  name: 'Launch crew',
  hostId: 'local',
  revision: 1,
  folder: 'group-launch-crew',
  folderWorkspaceId: 'fw-launch-crew',
  createdAt: 2000,
  members: crew.members.map(({ botId }) => ({ botId, sessionId: `s-${botId}` })),
  replyMode: { kind: 'bot', botId: superBot.id },
  fromOfferId: crew.offerId
}

function Card(): React.JSX.Element {
  return (
    <div className="p-4">
      <NativeChatBotGroupOfferCard offer={crew} messageId="offer-0" fallback="" />
    </div>
  )
}

export const offer = defineFixture({
  width: 640,
  setup: () => stubBots([superBot, notes, review]),
  render: () => <Card />
})

export const created = defineFixture({
  width: 640,
  setup: () =>
    stubBots([superBot, notes, review], undefined, {
      results: { 'bots.groups.list': { groups: [made] } }
    }),
  render: () => <Card />
})

// Deleted since the card was shown: Create is off, and the card says why.
export const memberGone = defineFixture({
  width: 640,
  setup: () => stubBots([superBot, notes]),
  render: () => <Card />
})

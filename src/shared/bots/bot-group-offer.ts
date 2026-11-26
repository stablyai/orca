// A group chat a bot proposes with `orca bot group create --offer`: a card in its chat. Nothing is
// created until the owner presses Create group; the card then reads Created, from the groups there are.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'
import { BotNameSchema } from '../bot-types'
import type { BotCardSay } from '../native-chat/bot-cards/bot-card-copy'
import type { BotGroup } from './bot-group-schema'

export const BOT_GROUP_OFFER_PRESENTATION = 'bot-group-offer'
export const BOT_GROUP_OFFER_MAX_MEMBERS = 32

export const BotGroupOfferSchema = z.object({
  /** The bot that proposed it. */
  botId: z.string().min(1),
  /** This card's own id: the group made from it records it, so a second press makes no second group. */
  offerId: z.string().min(1),
  name: BotNameSchema,
  /** The bots it would hold, named as they were when proposed; the first answers by default. */
  members: z
    .array(z.object({ botId: z.string().min(1), name: z.string().min(1) }))
    .min(1)
    .max(BOT_GROUP_OFFER_MAX_MEMBERS),
  /** One line: what the group is for. */
  purpose: z.string().trim().min(1).max(300).optional(),
  offeredAt: z.number()
})

export type BotGroupOffer = z.infer<typeof BotGroupOfferSchema>

/** `bots.groups.createOffer`: Orca reads each member's name itself, and puts the calling bot first. */
export const BotGroupOfferRequest = BotGroupOfferSchema.pick({ name: true, purpose: true }).extend({
  callerSessionId: z.string().min(1, "Run this from a bot's chat."),
  botIds: z.array(z.string().min(1)).max(BOT_GROUP_OFFER_MAX_MEMBERS),
  /** The calling bot proposes the group without joining it. */
  withoutCaller: z.literal(true).optional()
})

/** The line a client that can't draw the card shows instead. */
export function botGroupOfferText(offer: BotGroupOffer, botName: string): string {
  const members = offer.members.map((member) => member.name).join(', ')
  return `${botName} suggests a group chat, ${offer.name}, with ${members}. Create it from the card in Orca on your computer.`
}

export function botGroupOfferBody(
  offer: BotGroupOffer,
  botName: string
): AgentJournalPlainStatusItem & { botGroupOffer: BotGroupOffer } {
  return {
    kind: 'status',
    text: botGroupOfferText(offer, botName),
    presentation: BOT_GROUP_OFFER_PRESENTATION,
    botGroupOffer: offer
  }
}

/** The offer on a journal item, or null when it carries none or one this build can't read. */
export function botGroupOfferOf(body: AgentJournalItemBody): BotGroupOffer | null {
  if (!('botGroupOffer' in body)) {
    return null
  }
  const parsed = BotGroupOfferSchema.safeParse(body.botGroupOffer)
  return parsed.success ? parsed.data : null
}

/** The group made from this card, while it is there. A deleted group leaves the card open again. */
export function botGroupOfferCreated<Group extends Pick<BotGroup, 'fromOfferId'>>(
  offer: Pick<BotGroupOffer, 'offerId'>,
  groups: readonly Group[]
): Group | null {
  return groups.find((group) => group.fromOfferId === offer.offerId) ?? null
}

export const BOT_GROUP_OFFER_COPY = {
  heading: 'New group',
  created: 'Created',
  create: 'Create group',
  open: 'Open',
  members: 'With {{names}}',
  memberGone: '{{name}} is gone, so this group can’t be created.'
} as const

export type BotGroupOfferSay = BotCardSay<keyof typeof BOT_GROUP_OFFER_COPY>

export type BotGroupOfferView = {
  createdGroupId: string | null
  title: string
  /** Who would be in it, by their names now. */
  members: string
  purpose: string | null
  /** While open: a member that was deleted since, which blocks Create. */
  blocked: string | null
}

export function botGroupOfferView(
  offer: BotGroupOffer,
  created: Pick<BotGroup, 'id' | 'name'> | null,
  /** The bots there are now, on the proposing bot's computer. */
  bots: readonly { id: string; name: string }[],
  say: BotGroupOfferSay
): BotGroupOfferView {
  const nameNow = (member: BotGroupOffer['members'][number]) =>
    bots.find((bot) => bot.id === member.botId)?.name
  const gone = created ? undefined : offer.members.find((member) => !nameNow(member))
  return {
    createdGroupId: created?.id ?? null,
    title: created?.name ?? offer.name,
    members: say('members', {
      names: offer.members.map((member) => nameNow(member) ?? member.name).join(', ')
    }),
    purpose: offer.purpose ?? null,
    blocked: gone ? say('memberGone', { name: gone.name }) : null
  }
}

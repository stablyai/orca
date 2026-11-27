import { lazyZodSchema } from '../schema/lazy-zod-schema'
// A new bot, proposed before it exists: by a template or by a bot's
// `orca bot create --offer` card. The prefilled New bot dialog edits one, and bots.create makes it.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'
import type { BotCreateParams } from '../rpc-contract/bots-params'
import { isBotMascotId, mascotAvatar } from '../bot-avatar'
import { type Bot, type BotAgent, BotNameSchema } from '../bot-types'
import {
  BOT_CONNECTOR_NAMES,
  type BotTemplate,
  botTemplate,
  isLegacyBotTemplateId
} from './bot-templates'
import { HANDED_WORKSPACES_MAX, HandedWorkspaceSchema } from './bot-made-for-workspaces'

const line = (max: number) => z.string().trim().min(1).max(max)

export const BOT_PURPOSE_MAX_LENGTH = 1000
// Hosts before the 1,000 limit refuse more with a schema error naming this one.
const OLDER_HOST_PURPOSE_MAX_LENGTH = 200

/** Whether a host refused a create only because it is older and checks the earlier 200 limit. */
export function refusedForOlderHostPurposeLimit(
  code: string | undefined,
  message: string,
  purpose: string | undefined
): boolean {
  return (
    code === 'invalid_argument' &&
    (purpose?.length ?? 0) > OLDER_HOST_PURPOSE_MAX_LENGTH &&
    message.includes(`<=${OLDER_HOST_PURPOSE_MAX_LENGTH}`)
  )
}

/** What goes into the new bot's SOUL.md. */
export const BotProposalSeedSchema = z.object({
  /** One sentence: what the bot is for. SOUL.md's first paragraph, so `bot list` shows it. */
  purpose: line(BOT_PURPOSE_MAX_LENGTH),
  watches: line(300).optional(),
  does: line(500).optional(),
  /** Where and how often it reports ("Here, weekday mornings"). */
  reports: line(200).optional(),
  /** Automations it should set up once its owner agrees ("Weekdays 9:00: triage new relay issues"). */
  automations: z.array(line(200)).max(3).optional(),
  /** A built-in template's id; an id this build doesn't know shows no "From" line. */
  templateId: z.string().max(64).optional()
})

export type BotProposalSeed = z.infer<typeof BotProposalSeedSchema>

export const BotProposalSchema = lazyZodSchema(() =>
  BotProposalSeedSchema.extend({
    name: BotNameSchema,
    /** A mascot id; absent, the new bot gets a random one. */
    mascot: z.string().refine(isBotMascotId).optional(),
    /** Workspaces it is made for: its first turn offers to take them over. */
    worktrees: z.array(HandedWorkspaceSchema).max(HANDED_WORKSPACES_MAX).optional()
  })
)

export type BotProposal = z.infer<typeof BotProposalSchema>

/** A template as a proposal, for the owner to edit before creating. */
export function templateProposal(
  template: BotTemplate,
  overrides: Partial<BotProposal> = {}
): BotProposal {
  return {
    name: template.name,
    mascot: template.mascot,
    purpose: template.line,
    watches: template.watches,
    does: template.does,
    reports: template.reports,
    templateId: template.id,
    ...overrides
  }
}

export function proposalSeed({
  purpose,
  watches,
  does,
  reports,
  automations,
  templateId
}: BotProposalSeed): BotProposalSeed {
  return {
    purpose,
    ...(watches ? { watches } : {}),
    ...(does ? { does } : {}),
    ...(reports ? { reports } : {}),
    ...(automations?.length ? { automations } : {}),
    ...(templateId ? { templateId } : {})
  }
}

/** Where the bot is made: whether that host applies template packages (`bots.templates.v2`), and the
 *  template skills the owner kept (absent: all of them). */
export type ProposalCreateTarget = {
  templatePackages: boolean
  skills?: readonly string[]
  /** The template's name as this client shows it, when it proposed the bot's name in that language. */
  templateNameShown?: string
  /** From a bot's card: that card. */
  fromOffer?: BotCreateParams['fromOffer']
}

/** The one bots.create request every proposal makes. An older host gets the seed only, and a templateId
 *  only if its enum has it (any other would fail the whole create). */
export function proposalCreateParams(
  proposal: BotProposal,
  agent: BotAgent,
  target: ProposalCreateTarget
): BotCreateParams {
  const template = botTemplate(proposal.templateId)
  const keepId =
    !proposal.templateId || target.templatePackages || isLegacyBotTemplateId(proposal.templateId)
  const seed = proposalSeed(keepId ? proposal : { ...proposal, templateId: undefined })
  return {
    name: proposal.name.trim(),
    agent,
    ...(proposal.mascot && isBotMascotId(proposal.mascot)
      ? { avatar: mascotAvatar(proposal.mascot) }
      : {}),
    ...(proposal.worktrees?.length ? { handOff: proposal.worktrees } : {}),
    seed,
    ...(template && target.templatePackages
      ? { fromTemplate: { id: template.id, skills: [...(target.skills ?? template.skills)] } }
      : {}),
    ...(template && target.templateNameShown
      ? { templateNameShown: target.templateNameShown }
      : {}),
    ...(target.fromOffer ? { fromOffer: target.fromOffer } : {})
  }
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim()

// Names that keep their capital mid-sentence ("Watches Linear projects", "Watches your Orca workspaces").
const PROPER_NAMES = new Set([...Object.values(BOT_CONNECTOR_NAMES), 'Orca'])
const midSentence = (text: string): string =>
  PROPER_NAMES.has(text.split(' ', 1)[0] ?? '')
    ? text
    : text.charAt(0).toLowerCase() + text.slice(1)
const sentence = (text: string): string => (/[.!?]$/.test(text) ? text : `${text}.`)

/** What a template's bot watches, does and reports, as the plain sentences New bot's identity box shows. */
export function proposalIdentity({
  watches,
  does,
  reports
}: Pick<BotProposal, 'watches' | 'does' | 'reports'>): string {
  return [
    watches ? `Watches ${midSentence(oneLine(watches))}` : null,
    does ? oneLine(does) : null,
    reports ? `Reports ${midSentence(oneLine(reports))}` : null
  ]
    .filter((entry): entry is string => entry !== null)
    .map(sentence)
    .join(' ')
}

const READ_ONLY_START =
  '- Change anything (comments, labels, pull requests, posts anywhere but here) until my owner says I can. I start by reading and reporting only.'

/** SOUL.md for a bot made from a proposal: the purpose first, then how it works; it starts read-only. */
export function proposalSoul(name: string, seed: BotProposalSeed): string {
  const template = botTemplate(seed.templateId)
  const how = [
    seed.watches ? `- Watches: ${oneLine(seed.watches)}` : null,
    seed.does ? `- Does: ${oneLine(seed.does)}` : null,
    seed.reports ? `- Reports: ${oneLine(seed.reports)}` : null,
    seed.automations?.length
      ? `- Automations to set up once my owner agrees: ${seed.automations.map(oneLine).join('; ')}`
      : null,
    template ? `- Started from the ${template.name} template.` : null
  ].filter((entry): entry is string => entry !== null)
  return `${[
    `# ${name}`,
    oneLine(seed.purpose),
    ...(how.length ? [`## How I work\n\n${how.join('\n')}`] : []),
    `## Never\n\n${READ_ONLY_START}`
  ].join('\n\n')}\n`
}

// ---- The card a bot shows with `orca bot create --offer` ----

export const BOT_CREATE_OFFER_PRESENTATION = 'bot-create-offer'

export const BotCreateOfferSchema = z.object({
  /** The bot that proposed it. */
  botId: z.string().min(1),
  /** This card's own id: creating from it, directly or through Edit, records the new bot against it. */
  offerId: z.string().min(1),
  proposal: BotProposalSchema,
  offeredAt: z.number()
})

export type BotCreateOffer = z.infer<typeof BotCreateOfferSchema>

/** The line a client that can't draw the card shows instead. */
export function botCreateOfferText(offer: BotCreateOffer, botName: string): string {
  const { name, purpose, worktrees } = offer.proposal
  const takes = worktrees?.length
    ? ` It would take over ${worktrees.map((entry) => entry.name).join(', ')}.`
    : ''
  return `${botName} suggests a new bot, ${name}: ${purpose}${takes} Create it from New bot in Orca.`
}

export function botCreateOfferBody(
  offer: BotCreateOffer,
  botName: string
): AgentJournalPlainStatusItem & { botCreateOffer: BotCreateOffer } {
  return {
    kind: 'status',
    text: botCreateOfferText(offer, botName),
    presentation: BOT_CREATE_OFFER_PRESENTATION,
    botCreateOffer: offer
  }
}

/** The offer on a journal item, or null when it carries none or one this build can't read. */
export function botCreateOfferOf(body: AgentJournalItemBody): BotCreateOffer | null {
  if (!('botCreateOffer' in body)) {
    return null
  }
  const parsed = BotCreateOfferSchema.safeParse(body.botCreateOffer)
  return parsed.success ? parsed.data : null
}

/** Where the card stands: accepted (by its id, on the proposing bot's record, so a rename or an edited
 *  name never loses it), its name taken by a bot that is there now, or open. */
export function botCreateOfferState(
  offer: Pick<BotCreateOffer, 'offerId' | 'proposal'>,
  proposer: Pick<Bot, 'acceptedOffers'>,
  bots: readonly Pick<Bot, 'id' | 'name'>[]
):
  | { kind: 'open' }
  | { kind: 'created'; botId: string }
  | { kind: 'deleted' }
  | { kind: 'nameTaken' } {
  const accepted = proposer.acceptedOffers?.find((entry) => entry.offerId === offer.offerId)
  if (accepted) {
    return bots.some((bot) => bot.id === accepted.botId)
      ? { kind: 'created', botId: accepted.botId }
      : { kind: 'deleted' }
  }
  const wanted = offer.proposal.name.trim().toLowerCase()
  return bots.some((bot) => bot.name.trim().toLowerCase() === wanted)
    ? { kind: 'nameTaken' }
    : { kind: 'open' }
}

/** The proposing bot's record once the owner created a bot from one of its cards. */
export function withAcceptedOffer(
  proposer: Pick<Bot, 'acceptedOffers'>,
  offerId: string,
  botId: string
): NonNullable<Bot['acceptedOffers']> {
  // Never trimmed: it is the only record that the card was accepted, for as long as the card lasts.
  return [...(proposer.acceptedOffers ?? []), { offerId, botId }]
}

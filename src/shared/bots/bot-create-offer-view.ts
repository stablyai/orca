// What a bot's create offer card shows: its title and line, the note and buttons while it's open, and
// Open once the bot exists. Each platform draws it and passes its translations.
import type { Bot } from '../bot-types'
import type { BotCardSay } from '../native-chat/bot-cards/bot-card-copy'
import { folderWorkspaceKey, workspaceKeyOfRow } from '../workspace/identity/workspace-scope'
import type { WorkspaceKey } from '../workspace/identity/workspace-scope'
import { botTemplate } from './bot-templates'
import type { BotCreateOffer, BotProposal, botCreateOfferState } from './bot-proposal'

type BotCreateOfferState = ReturnType<typeof botCreateOfferState>

export const BOT_CREATE_OFFER_COPY = {
  takesOverOne: 'Takes over 1 workspace',
  takesOverMany: 'Takes over {{count}} workspaces',
  created: 'Created',
  createdAskedOne: 'Created · asked to take over 1 workspace',
  createdAskedMany: 'Created · asked to take over {{count}} workspaces',
  createdTookOverSome: 'Created · took over {{taken}} of {{count}} workspaces',
  createdTookOverOne: 'Created · took over 1 workspace',
  createdTookOverMany: 'Created · took over {{count}} workspaces',
  askedOne: 'Asked to take over 1 workspace',
  askedMany: 'Asked to take over {{count}} workspaces',
  tookOverSome: 'Took over {{taken}} of {{count}} workspaces',
  tookOverOne: 'Took over 1 workspace',
  tookOverMany: 'Took over {{count}} workspaces',
  deleted: 'Created, then deleted',
  nameTaken: 'You already have a bot named {{name}}.',
  rename: 'Rename',
  edit: 'Edit',
  create: 'Create bot',
  open: 'Open',
  origin: 'Proposed by {{bot}}',
  originTemplate: 'From {{template}}, proposed by {{bot}}',
  watches: 'Watches',
  does: 'Does',
  reports: 'Reports',
  willPropose: 'Will propose',
  takesOver: 'Takes over',
  template: 'Template'
} as const

export type BotCreateOfferSay = BotCardSay<keyof typeof BOT_CREATE_OFFER_COPY>

/** A built-in template's words in the UI language; callers that don't translate keep the English. */
export type BotOfferShownText = (english: string) => string
const asWritten: BotOfferShownText = (text) => text

export type BotCreateOfferView = {
  /** The bot made from the offer, while it's there. */
  createdBotId: string | null
  title: string
  line: { kind: 'created' | 'deleted' | 'purpose'; text: string }
  /** Once created with workspaces to take over: how that went, for a card whose state already says Created. */
  takeover: string | null
  /** While the offer is open: a note beside its buttons, and which buttons show. */
  open: { note: string | null; actions: 'rename' | 'editAndCreate' } | null
}

/** How many of the asked-for workspaces are under the new bot now: its first turn takes them over, so
 *  until then (or if that fails) the card never claims it did. */
export function botCreateOfferTakenOver(
  bot: Pick<Bot, 'folderWorkspaceId'> | undefined,
  worktrees: BotProposal['worktrees'],
  parentOf: (child: WorkspaceKey) => WorkspaceKey | undefined
): number {
  if (!bot || !worktrees?.length) {
    return 0
  }
  const home = folderWorkspaceKey(bot.folderWorkspaceId)
  return worktrees.filter((entry) => parentOf(workspaceKeyOfRow(entry.id)) === home).length
}

function takeoverLine(taken: number, count: number, say: BotCreateOfferSay): string | null {
  if (count === 0) {
    return null
  }
  if (taken === 0) {
    return count === 1 ? say('askedOne') : say('askedMany', { count })
  }
  if (taken < count) {
    return say('tookOverSome', { taken, count })
  }
  return count === 1 ? say('tookOverOne') : say('tookOverMany', { count })
}

function createdLine(taken: number, count: number, say: BotCreateOfferSay): string {
  if (count === 0) {
    return say('created')
  }
  if (taken === 0) {
    return count === 1 ? say('createdAskedOne') : say('createdAskedMany', { count })
  }
  if (taken < count) {
    return say('createdTookOverSome', { taken, count })
  }
  return count === 1 ? say('createdTookOverOne') : say('createdTookOverMany', { count })
}

export function botCreateOfferView(
  offer: BotCreateOffer,
  /** From `botCreateOfferState`. */
  state: BotCreateOfferState,
  /** The bot made from the offer, as the bots list has it. */
  created: Pick<Bot, 'name'> | undefined,
  /** From `botCreateOfferTakenOver`, for the created bot. */
  taken: number,
  say: BotCreateOfferSay,
  shown: BotOfferShownText = asWritten
): BotCreateOfferView {
  const { proposal } = offer
  const count = proposal.worktrees?.length ?? 0
  if (state.kind === 'created') {
    return {
      createdBotId: state.botId,
      title: created?.name ?? proposal.name,
      line: { kind: 'created', text: createdLine(taken, count, say) },
      takeover: takeoverLine(taken, count, say),
      open: null
    }
  }
  if (state.kind === 'deleted') {
    return {
      createdBotId: null,
      title: proposal.name,
      line: { kind: 'deleted', text: say('deleted') },
      takeover: null,
      open: null
    }
  }
  const nameTaken = state.kind === 'nameTaken'
  const note = nameTaken
    ? say('nameTaken', { name: proposal.name })
    : count === 0
      ? null
      : count === 1
        ? say('takesOverOne')
        : say('takesOverMany', { count })
  return {
    createdBotId: null,
    title: proposal.name,
    line: { kind: 'purpose', text: shown(proposal.purpose) },
    takeover: null,
    open: { note, actions: nameTaken ? 'rename' : 'editAndCreate' }
  }
}

/** Who proposed the bot, on its Edit sheet. */
export function botCreateOfferOrigin(
  proposal: BotProposal,
  proposerName: string,
  say: BotCreateOfferSay,
  shown: BotOfferShownText = asWritten
): string {
  const template = botTemplate(proposal.templateId)
  return template
    ? say('originTemplate', { template: shown(template.name), bot: proposerName })
    : say('origin', { bot: proposerName })
}

export type BotProposalDetail = {
  label: Extract<
    keyof typeof BOT_CREATE_OFFER_COPY,
    'watches' | 'does' | 'reports' | 'willPropose' | 'takesOver' | 'template'
  >
  text: string
}

/** What a proposed bot would watch, do and report, under its card's Details. */
export function botProposalDetails(
  proposal: BotProposal,
  shown: BotOfferShownText = asWritten
): BotProposalDetail[] {
  const template = botTemplate(proposal.templateId)
  const details: (BotProposalDetail | null)[] = [
    proposal.watches ? { label: 'watches', text: shown(proposal.watches) } : null,
    proposal.does ? { label: 'does', text: shown(proposal.does) } : null,
    proposal.reports ? { label: 'reports', text: shown(proposal.reports) } : null,
    proposal.automations?.length
      ? { label: 'willPropose', text: proposal.automations.join(' · ') }
      : null,
    proposal.worktrees?.length
      ? { label: 'takesOver', text: proposal.worktrees.map((entry) => entry.name).join(', ') }
      : null,
    template ? { label: 'template', text: shown(template.name) } : null
  ]
  return details.filter((detail) => detail !== null)
}

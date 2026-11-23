// New bot's typed fields and what the bot is made from: a proposal as edited, or a purpose alone.
// A built-in template reads in the UI language; text the owner leaves as shown is saved in the
// template's English, so SOUL.md keeps the words the template was written in.
import type { Translate } from '@/i18n/use-translate'
import {
  BOT_PURPOSE_MAX_LENGTH,
  proposalIdentity,
  type BotProposal
} from '../../../../shared/bots/bot-proposal'
import { botTemplate } from '../../../../shared/bots/bot-templates'
import { botTemplateText } from '../../../../shared/bots/bot-template-text'
import { finalSentenceStop, joinSentences } from '../../../../shared/text/sentence-joining'
import type { NewBotProposalDraft } from './NewBotProposalFields'

export type NewBotDraft = NewBotProposalDraft & { purpose: string }

/** A built-in template's words read in the UI language; anything else shows as written. */
const shownText = (text: string | undefined, t: Translate): string | undefined =>
  text === undefined ? undefined : botTemplateText(text, t)

/** A template's identity box: what it watches, does and reports, one editable text. */
export const templateIdentity = (proposal: BotProposal | undefined): string | undefined =>
  (proposal && botTemplate(proposal.templateId) && proposalIdentity(proposal)) || undefined

/** The identity box in the UI language: the template's lines translated, put together as sentences. */
export function shownTemplateIdentity(
  proposal: BotProposal | undefined,
  t: Translate
): string | undefined {
  const identity = templateIdentity(proposal)
  if (!proposal || identity === undefined) {
    return identity
  }
  const watches = shownText(proposal.watches, t)
  const does = shownText(proposal.does, t)
  const reports = shownText(proposal.reports, t)
  // Translated only when every line is: a bot's own lines beside template ones would mix languages.
  const lines = [
    [proposal.watches, watches],
    [proposal.does, does],
    [proposal.reports, reports]
  ] as const
  if (lines.some(([own, line]) => own && line === own)) {
    return identity
  }
  const text = joinSentences(
    [
      watches ? t('bots.new.identityWatches', 'Watches {{what}}', { what: watches }) : null,
      does || null,
      reports ? t('bots.new.identityReports', 'Reports {{what}}', { what: reports }) : null
    ].filter((line): line is string => line !== null)
  )
  return `${text}${finalSentenceStop(text)}`
}

export const draftOf = (proposal: BotProposal | undefined, purpose?: string): NewBotDraft => ({
  purpose: templateIdentity(proposal) ?? proposal?.purpose ?? purpose ?? '',
  watches: proposal?.watches,
  does: proposal?.does,
  reports: proposal?.reports
})

/** The draft as New bot shows it: text still as the proposal wrote it reads in the UI language, at
 *  every render, so it follows the catalog arriving or the language changing. */
export function shownDraft(
  proposal: BotProposal | undefined,
  draft: NewBotDraft,
  t: Translate
): NewBotDraft {
  if (!proposal) {
    return draft
  }
  const shown = (value: string | undefined, own: string | undefined): string | undefined =>
    value !== undefined && value === own ? shownText(value, t) : value
  const identity = templateIdentity(proposal)
  return {
    purpose:
      identity !== undefined && draft.purpose === identity
        ? (shownTemplateIdentity(proposal, t) ?? identity)
        : (shown(draft.purpose, proposal.purpose) ?? ''),
    watches: shown(draft.watches, proposal.watches),
    does: shown(draft.does, proposal.does),
    reports: shown(draft.reports, proposal.reports)
  }
}

/** A field typed back to exactly what New bot shows keeps the proposal's own words, so a later
 *  language change can't make restored text look edited. */
export function canonicalDraft(
  proposal: BotProposal | undefined,
  draft: NewBotDraft,
  t: Translate
): NewBotDraft {
  if (!proposal) {
    return draft
  }
  const own = draftOf(proposal)
  const shown = shownDraft(proposal, own, t)
  const kept = (typed: string | undefined, seen: string | undefined, mine: string | undefined) =>
    typed !== undefined && mine !== undefined && typed.trim() === seen?.trim() ? mine : typed
  return {
    purpose: kept(draft.purpose, shown.purpose, own.purpose) ?? '',
    watches: kept(draft.watches, shown.watches, own.watches),
    does: kept(draft.does, shown.does, own.does),
    reports: kept(draft.reports, shown.reports, own.reports)
  }
}

/** Whether the identity box still holds the template's text, as written or as shown. */
export function identityUntouched(
  proposal: BotProposal | undefined,
  purpose: string,
  t: Translate
): boolean {
  const typed = purpose.trim()
  return (
    typed === templateIdentity(proposal) || typed === shownTemplateIdentity(proposal, t)?.trim()
  )
}

/** An edited template identity becomes the bot's purpose, so it keeps the purpose's limit. */
export function templateIdentityTooLong(
  proposal: BotProposal | undefined,
  purpose: string,
  t: Translate
): boolean {
  return (
    templateIdentity(proposal) !== undefined &&
    !identityUntouched(proposal, purpose, t) &&
    purpose.trim().length > BOT_PURPOSE_MAX_LENGTH
  )
}

// An emptied field drops out of the new bot's SOUL.md.
const trimmedDraft = (draft: NewBotProposalDraft): NewBotProposalDraft => ({
  watches: draft.watches?.trim() || undefined,
  does: draft.does?.trim() || undefined,
  reports: draft.reports?.trim() || undefined
})

/** What the new bot is made from: the proposal as edited, or a typed purpose on its own. Either seeds
 *  SOUL.md; a cleared purpose keeps the proposal's, which its other lines need. */
export function editedProposal(
  proposal: BotProposal | undefined,
  draft: NewBotDraft,
  name: string,
  t: Translate
): BotProposal | null {
  const purpose = draft.purpose.trim()
  if (proposal && templateIdentity(proposal) !== undefined) {
    // Untouched, the template's own lines seed SOUL.md; edited, the identity text replaces them.
    return identityUntouched(proposal, purpose, t)
      ? { ...proposal, name }
      : {
          ...proposal,
          name,
          purpose: purpose || proposal.purpose,
          watches: undefined,
          does: undefined,
          reports: undefined
        }
  }
  if (proposal) {
    // Why: a line left as shown keeps the proposal's own words, so SOUL.md gets the English the
    // template was written in rather than its translation; an edited line keeps the owner's words.
    const kept = (edited: string | undefined, own: string | undefined): string | undefined =>
      own !== undefined && edited?.trim() === shownText(own, t)?.trim() ? own : edited
    return {
      ...proposal,
      ...trimmedDraft({
        watches: kept(draft.watches, proposal.watches),
        does: kept(draft.does, proposal.does),
        reports: kept(draft.reports, proposal.reports)
      }),
      name,
      purpose: kept(purpose, proposal.purpose) || proposal.purpose
    }
  }
  return purpose ? { name, purpose } : null
}

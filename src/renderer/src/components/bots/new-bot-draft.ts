// New bot's draft: a proposal's lines as the dialog shows them, and what the new bot is made from.
// A built-in template reads in the UI language; a line the owner leaves as shown is saved in the
// template's English, so SOUL.md keeps the words the template was written in.
import type { Translate } from '@/i18n/use-translate'
import type { BotProposal } from '../../../../shared/bots/bot-proposal'
import { botTemplateText } from '../../../../shared/bots/bot-template-text'
import type { NewBotProposalDraft } from './NewBotProposalFields'

export type NewBotDraft = NewBotProposalDraft & { purpose: string }

/** A built-in template's words read in the UI language; anything else shows as written. */
const shownText = (text: string | undefined, t: Translate): string | undefined =>
  text === undefined ? undefined : botTemplateText(text, t)

export const draftOf = (proposal: BotProposal | undefined, purpose?: string): NewBotDraft => ({
  purpose: proposal?.purpose ?? purpose ?? '',
  watches: proposal?.watches,
  does: proposal?.does,
  reports: proposal?.reports
})

/** The draft as New bot shows it: a line still as the proposal wrote it reads in the UI language, at
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
  return {
    purpose: shown(draft.purpose, proposal.purpose) ?? '',
    watches: shown(draft.watches, proposal.watches),
    does: shown(draft.does, proposal.does),
    reports: shown(draft.reports, proposal.reports)
  }
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

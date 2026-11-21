// New bot's typed fields and what the bot is made from: a proposal as edited, or a purpose alone.
import { proposalIdentity, type BotProposal } from '../../../../shared/bots/bot-proposal'
import { botTemplate } from '../../../../shared/bots/bot-templates'
import type { NewBotProposalDraft } from './NewBotProposalFields'

export type NewBotDraft = NewBotProposalDraft & { purpose: string }

/** A template's identity box: what it watches, does and reports, one editable text. */
export const templateIdentity = (proposal: BotProposal | undefined): string | undefined =>
  (proposal && botTemplate(proposal.templateId) && proposalIdentity(proposal)) || undefined

export const draftOf = (proposal: BotProposal | undefined, purpose?: string): NewBotDraft => ({
  purpose: templateIdentity(proposal) ?? proposal?.purpose ?? purpose ?? '',
  watches: proposal?.watches,
  does: proposal?.does,
  reports: proposal?.reports
})

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
  name: string
): BotProposal | null {
  const purpose = draft.purpose.trim()
  const identity = templateIdentity(proposal)
  if (proposal && identity !== undefined) {
    // Untouched, the template's own lines seed SOUL.md; edited, the identity text replaces them.
    return purpose === identity
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
    return {
      ...proposal,
      ...trimmedDraft(draft),
      name,
      purpose: purpose || proposal.purpose
    }
  }
  return purpose ? { name, purpose } : null
}

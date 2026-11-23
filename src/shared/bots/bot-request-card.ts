// The card a bot request leaves in the owner's own chat with the sending bot: who it went to, as a
// question or a handoff, and how it ended, or why it wasn't sent. Older clients and the phone paint
// its `text` as a plain line.
import * as z from 'zod'
import type {
  AgentJournalItemBody,
  AgentJournalPlainStatusItem
} from '../agent-session/journal/agent-session-journal-types'

export const BOT_REQUEST_CARD_PRESENTATION = 'bot-request'

export const BotRequestCardSchema = z.object({
  toBotId: z.string().min(1),
  toBotName: z.string().min(1).max(200),
  purpose: z.enum(['question', 'handoff']),
  subject: z.string().max(300),
  /** The request's mail; absent when Orca refused to send it. */
  messageId: z.string().min(1).optional(),
  /** Why it wasn't sent: a bot-request refusal code. */
  refusal: z.string().min(1).max(80).optional(),
  /** Sent to an agent on a computer paired to this host (`send --on-client`): that computer, by its
   *  installation id and name. An older client drops it and shows the plain line. */
  client: z.object({ installationId: z.string().min(1), computer: z.string().max(200) }).optional()
})

export type BotRequestCard = z.infer<typeof BotRequestCardSchema>

/** How a sent request stands, as Orca recorded it; null while nothing has. */
export type BotRequestCardOutcome = 'answered' | 'posted' | 'unanswered' | 'dropped' | null

/** What the card reads: the outcome, the answer, the mail that carried them, and the chat it was sent to. */
export type BotRequestCardReading = {
  outcome: BotRequestCardOutcome
  answer: string | null
  mailIds: string[]
  /** The receiving bot's chat the request was mailed to; absent from hosts before it. */
  chatId?: string | null
}

/** The line a client that can't draw the card shows instead. */
export function botRequestCardText(card: BotRequestCard): string {
  const to = card.client ? `${card.toBotName} on ${card.client.computer}` : card.toBotName
  if (!card.messageId) {
    return `Not sent to ${to}: ${card.subject}`
  }
  return card.purpose === 'question'
    ? `Asked ${to}: ${card.subject}`
    : `Handed to ${to}: ${card.subject}`
}

export function botRequestCardBody(
  card: BotRequestCard
): AgentJournalPlainStatusItem & { botRequest: BotRequestCard } {
  return {
    kind: 'status',
    text: botRequestCardText(card),
    presentation: BOT_REQUEST_CARD_PRESENTATION,
    botRequest: card
  }
}

/** The card on a journal item, or null when it carries none or one this build can't read. */
export function botRequestCardOf(body: AgentJournalItemBody): BotRequestCard | null {
  if (!('botRequest' in body)) {
    return null
  }
  const parsed = BotRequestCardSchema.safeParse(body.botRequest)
  return parsed.success ? parsed.data : null
}

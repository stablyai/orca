// An agent's Needs you question: one normal comment with its body (`--comment`), its question lines
// (`--ask`, once per decision) and each one's quick replies (`--option`, `--recommended`). The owner
// answers with a quick reply or in their own words, as a plain comment.
import * as z from 'zod'
import { BOT_ITEM_LIMITS, type BotItem } from './bot-items'

export const BOT_ITEM_ASK_LIMITS = {
  questions: 5,
  options: 8,
  prompt: 500,
  label: 150,
  detail: 500
} as const

const L = BOT_ITEM_ASK_LIMITS

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

const OptionSchema = z.object({
  label: z.string().trim().min(1, 'An option needs its label.').max(L.label),
  detail: z.string().trim().max(L.detail).optional()
})

const QuestionSchema = z
  .object({
    prompt: z.string().trim().min(1, 'A decision needs its question.').max(L.prompt),
    options: z.array(OptionSchema).max(L.options, `A decision takes up to ${L.options} options.`),
    /** Index into `options`. */
    recommended: z.number().int().min(0).optional(),
    /** Accepted as v1.4.265 bots send it; quick replies post one at a time. */
    multi: z.boolean().optional()
  })
  .refine(
    (question) =>
      question.recommended === undefined || question.recommended < question.options.length,
    'The recommended option is not one of its options.'
  )
  .refine(
    (question) => distinct(question.options.map((option) => option.label)),
    'Each option of a decision needs its own label.'
  )

export const BotItemAskSchema = z.object({
  /** The agent's own words around the decisions (`--comment`). */
  context: z.string().trim().max(BOT_ITEM_LIMITS.text).optional(),
  questions: z
    .array(QuestionSchema)
    .min(1)
    .max(L.questions, `An ask takes up to ${L.questions} decisions.`)
    .refine(
      (questions) => distinct(questions.map((question) => question.prompt)),
      'Each decision needs its own question.'
    )
})

export type BotItemAsk = z.infer<typeof BotItemAskSchema>

/** A question's first line as plain words, for a one-line row: no `**`, `#`, list marks, code ticks
 *  or link syntax, so a question the agent wrote in Markdown reads cleanly there. */
export function botItemQuestionLine(text: string): string {
  const first = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  return first
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
}

/** The ask a stored question event carries (written by v1.4.265 hosts), or null. */
export function botItemAskOf(data: Record<string, unknown>): BotItemAsk | null {
  const parsed = BotItemAskSchema.safeParse(data.ask)
  return parsed.success ? parsed.data : null
}

/** The ask as plain text, for the question comment's `text` (what readers without the ask show): the
 *  context, then each decision and its options. */
export function botItemAskText(ask: BotItemAsk): string {
  const decisions = ask.questions.map((question, index) => {
    const head = ask.questions.length > 1 ? `${index + 1}. ${question.prompt}` : question.prompt
    const options = question.options.map((option, at) => {
      const recommended = question.recommended === at ? ' (recommended)' : ''
      const detail = option.detail ? `: ${option.detail}` : ''
      return `   - ${option.label}${recommended}${detail}`
    })
    return [head, ...options].join('\n')
  })
  return [ask.context?.trim(), ...decisions].filter(Boolean).join('\n\n')
}

export type BotItemQuickReply = { label: string; detail?: string; recommended: boolean }

/** One question line of a Needs you comment, with its quick replies. */
export type BotItemDecision = { question: string; replies: BotItemQuickReply[] }

/** How a question comment reads: its body (`--comment`), then each question line (`--ask`) with its
 *  quick replies (`--option`). A comment with no ask is all body. */
export type BotItemQuestionShape = { body: string; decisions: BotItemDecision[] }

export function botItemQuestionShape(data: Record<string, unknown>): BotItemQuestionShape {
  const ask = botItemAskOf(data)
  if (!ask) {
    return { body: typeof data.text === 'string' ? data.text : '', decisions: [] }
  }
  return {
    body: ask.context ?? '',
    decisions: ask.questions.map((question) => ({
      question: question.prompt,
      replies: question.options.map((option, index) => ({
        label: option.label,
        ...(option.detail ? { detail: option.detail } : {}),
        recommended: question.recommended === index
      }))
    }))
  }
}

/** What a quick reply posts: its label, or with several questions, which one it answers too. */
export function botItemQuickReplyText(
  shape: BotItemQuestionShape,
  decision: BotItemDecision,
  reply: BotItemQuickReply
): string {
  return shape.decisions.length > 1
    ? `${botItemQuestionLine(decision.question)} → ${reply.label}`
    : reply.label
}

/** The quick replies an owner's reply picked for each question line, none where they wrote their own
 *  words: read from what a quick reply posts, or from the picks a v1.4.265 host recorded. */
export function botItemPickedReplies(
  shape: BotItemQuestionShape,
  reply: Record<string, unknown>
): BotItemQuickReply[][] {
  const text = typeof reply.text === 'string' ? reply.text.trim() : ''
  const recorded = Array.isArray(reply.decisions) ? reply.decisions : null
  return shape.decisions.map((decision, index) => {
    const picks: unknown = recorded?.[index]?.picks
    if (Array.isArray(picks)) {
      // A pick-several decision kept every pick.
      return decision.replies.filter((_, at) => picks.includes(at))
    }
    return decision.replies.filter(
      (option) => botItemQuickReplyText(shape, decision, option) === text
    )
  })
}

/** The open question as views get it with the item, so the hover card never waits on its event's
 *  page: its words, its body's first line as a gist, and its question lines with their quick replies. */
export function botItemQuestionView(
  eventId: string,
  data: Record<string, unknown>
): NonNullable<BotItem['question']> {
  const shape = botItemQuestionShape(data)
  return {
    eventId,
    text: typeof data.text === 'string' ? data.text : '',
    gist: botItemQuestionLine(shape.body),
    ...(shape.decisions.length > 0 ? { decisions: shape.decisions } : {})
  }
}

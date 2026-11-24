// An agent's Needs you question: one normal comment with its body (`--comment`), its question lines
// (`--ask`, once per decision) and each one's quick replies (`--option`, `--recommended`). The owner
// answers with a quick reply or in their own words, as a plain comment.
// Hosts keep the waiting ask that pairing works out from what this file reads, writes or limits: any change
// to it bumps WAITING_ASK_RULES (src/main/bots/bot-item-waiting-ask-keep.ts).
import * as z from 'zod'
import { markdownPlainLine } from '../markdown/markdown-plain-line'
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
    /** Pick several: the phone's ask card sends every pick in one reply; desktop quick replies post one at a time. */
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

/** A question's first line with words, as plain words, for a one-line row, so a question the agent wrote in
 *  Markdown reads cleanly there. */
export function botItemQuestionLine(text: string): string {
  for (const line of text.split('\n')) {
    const plain = markdownPlainLine(line)
    if (plain) {
      return plain
    }
  }
  return ''
}

/** Every way a question's first line has been written in "Question → answer" lines: this build's, then
 *  the one builds before #47963 wrote (code-span contents lost their marks), which old answers, drafts
 *  and older phones and servers still hold. */
export function botItemQuestionLeads(text: string): string[] {
  const first = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  const legacy = first
    .trim()
    .replace(/^(#{1,6}|>|[-*+]|\d+[.)])\s+/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])[*_]([^*_\s][^*_]*?)[*_](?=[^\w*]|$)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .trim()
  const line = botItemQuestionLine(text)
  return legacy && legacy !== line ? [line, legacy] : [line]
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

/** One question line of a Needs you comment, with its quick replies; `multi` takes several of them. */
export type BotItemDecision = { question: string; replies: BotItemQuickReply[]; multi?: true }

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
      })),
      ...(question.multi ? { multi: true as const } : {})
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

/** Per question of the ask, the "Question →" head `line` starts with, else undefined. Older builds'
 *  heads count only when none of this build's does, so one question's old head never takes a line
 *  another's current head names. */
export function botItemLineHeads(
  shape: BotItemQuestionShape,
  line: string
): (string | undefined)[] {
  const heads = shape.decisions.map((decision) =>
    botItemQuestionLeads(decision.question).map((lead) => `${lead} →`)
  )
  const current = heads.map(([head]) => (line.startsWith(head) ? head : undefined))
  return current.some(Boolean)
    ? current
    : heads.map((older) => older.slice(1).find((head) => line.startsWith(head)))
}

/** Whether `text` is what question `index`'s quick reply posts, as this build or an older one wrote it. */
export function botItemIsQuickReplyText(
  shape: BotItemQuestionShape,
  index: number,
  reply: BotItemQuickReply,
  text: string
): boolean {
  if (shape.decisions.length <= 1) {
    return text === reply.label
  }
  const head = botItemLineHeads(shape, text)[index]
  return head !== undefined && text === `${head} ${reply.label}`
}

/** The quick replies an owner's reply picked for each question line, none where they wrote their own
 *  words: read from what a quick reply posts, or from the picks a v1.4.265 host recorded. */
export function botItemPickedReplies(
  shape: BotItemQuestionShape,
  reply: Record<string, unknown>
): BotItemQuickReply[][] {
  const text = typeof reply.text === 'string' ? reply.text.trim() : ''
  const recorded = Array.isArray(reply.decisions) ? reply.decisions : null
  // With several questions, one comment can answer each on its own line.
  const lines = shape.decisions.length > 1 ? text.split('\n').map((line) => line.trim()) : [text]
  return shape.decisions.map((decision, index) => {
    const picks: unknown = recorded?.[index]?.picks
    if (Array.isArray(picks)) {
      // A pick-several decision kept every pick.
      return decision.replies.filter((_, at) => picks.includes(at))
    }
    const quick = decision.replies.filter((option) =>
      lines.some((line) => botItemIsQuickReplyText(shape, index, option, line))
    )
    return quick.length > 0 || !decision.multi ? quick : multiPicks(shape, index, lines)
  })
}

/** A pick-several line's picks sent as one answer, "A, B" (what botItemAnswersText writes for them). */
function multiPicks(
  shape: BotItemQuestionShape,
  index: number,
  lines: readonly string[]
): BotItemQuickReply[] {
  const decision = shape.decisions[index]
  const headOf = (at: string): string | undefined => botItemLineHeads(shape, at)[index]
  const line = shape.decisions.length > 1 ? lines.find((at) => headOf(at)) : lines[0]
  const head = line === undefined ? undefined : headOf(line)
  const words = (head ? line?.slice(head.length).trim() : line) ?? ''
  const picks = words ? labelRun(words, 0, decision.replies, new Set()) : null
  return picks ? decision.replies.filter((option) => picks.includes(option)) : []
}

/** `words` from `at` as whole option labels joined by ", ", or null: a label may hold ", " itself.
 *  `dead` holds the offsets already known not to read, so labels sharing prefixes stay linear. */
function labelRun(
  words: string,
  at: number,
  options: readonly BotItemQuickReply[],
  dead: Set<number>
): BotItemQuickReply[] | null {
  for (const option of options) {
    if (words.length - at === option.label.length && words.startsWith(option.label, at)) {
      return [option]
    }
    const next = at + option.label.length + 2
    const rest =
      words.startsWith(`${option.label}, `, at) && !dead.has(next)
        ? labelRun(words, next, options, dead)
        : null
    if (rest) {
      return [option, ...rest]
    }
  }
  dead.add(at)
  return null
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

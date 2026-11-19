// An agent's Needs you question with its decisions and choices (`--ask/--option`), and the owner's answer to
// it. Both ride on `commented` events: the ask on the agent's question, the answer on the owner's reply,
// whose `text` spells it out for readers that predate these fields.
import * as z from 'zod'
import { BOT_ITEM_LIMITS, type BotItem } from './bot-items'
import type { AskAnswerSelection } from '../native-chat/input/questions/native-chat-ask-answer'
import type { AskPrompt } from '../native-chat/input/questions/native-chat-ask-types'

export const BOT_ITEM_ASK_LIMITS = {
  questions: 5,
  options: 8,
  prompt: 500,
  label: 150,
  detail: 500,
  answer: 2_000
} as const

const L = BOT_ITEM_ASK_LIMITS

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
    multi: z.boolean().optional()
  })
  .refine(
    (question) =>
      question.recommended === undefined || question.recommended < question.options.length,
    'The recommended option is not one of its options.'
  )
  .refine(
    (question) => !question.multi || question.options.length >= 2,
    'Pick-several needs at least two options.'
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

function distinct(values: readonly string[]): boolean {
  return new Set(values).size === values.length
}

export type BotItemAsk = z.infer<typeof BotItemAskSchema>
export type BotItemAskQuestion = BotItemAsk['questions'][number]

/** One decision's answer: its picked options (indexes), or the owner's own words instead. */
export const BotItemAnswerSchema = z.object({
  picks: z.array(z.number().int().min(0)).max(L.options).default([]),
  // A transport cap only: answer validation holds words to 2,000 after trimming.
  text: z.string().max(BOT_ITEM_LIMITS.text).optional()
})

export const BotItemAnswersSchema = z.array(BotItemAnswerSchema).min(1).max(L.questions)

export type BotItemAnswer = z.infer<typeof BotItemAnswerSchema>

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

/** The ask a question event carries, or null for a question asked in prose. */
export function botItemAskOf(data: Record<string, unknown>): BotItemAsk | null {
  const parsed = BotItemAskSchema.safeParse(data.ask)
  return parsed.success ? parsed.data : null
}

/** The open question as views get it with the item: its words, its decisions (so its card never
 *  waits on its event's page), and whether its card takes a recorded answer. */
export function botItemQuestionView(
  eventId: string,
  data: Record<string, unknown>
): NonNullable<BotItem['question']> {
  const ask = botItemAskOf(data)
  return {
    eventId,
    text: typeof data.text === 'string' ? data.text : '',
    ...(ask ? { ask } : {}),
    ...(data.answerable === true ? { answerable: true as const } : {})
  }
}

/** An owner comment that answers a question: which event it answers, and the answers. */
export function botItemAnswerOf(
  data: Record<string, unknown>
): { questionEventId: string; answers: BotItemAnswer[] } | null {
  // `answers` names the question, as on a plain reply; `decisions` makes it a recorded answer.
  const answers = BotItemAnswersSchema.safeParse(data.decisions)
  return typeof data.answers === 'string' && answers.success
    ? { questionEventId: data.answers, answers: answers.data }
    : null
}

function typed(answer: BotItemAnswer | undefined): string {
  return answer?.text?.trim() ?? ''
}

/** Answers as stored and compared: typed words trimmed, blank words dropped. The client sends these
 *  and the host stores these, so both check the same values. */
export function normalizeBotItemAnswers(answers: readonly BotItemAnswer[]): BotItemAnswer[] {
  return answers.map((answer) => {
    const words = typed(answer)
    return words ? { picks: [...answer.picks], text: words } : { picks: [...answer.picks] }
  })
}

function decisionProblem(
  question: BotItemAskQuestion,
  answer: BotItemAnswer,
  number: number
): string | null {
  const { picks } = answer
  // As in chat's card: a single choice is a pick or words; one taking several may add a note.
  if (typed(answer) && picks.length > 0 && !question.multi) {
    return `Decision ${number} needs one answer: a choice or your own words.`
  }
  if (picks.some((pick) => pick >= question.options.length)) {
    return `Decision ${number} has no such option.`
  }
  if (new Set(picks).size !== picks.length || (!question.multi && picks.length > 1)) {
    return `Decision ${number} takes one choice.`
  }
  return null
}

function shapeProblem(ask: BotItemAsk | null, answers: readonly BotItemAnswer[]): string | null {
  if (!ask) {
    return answers.length === 1 && answers[0]!.picks.length === 0 && typed(answers[0])
      ? null
      : 'This question takes one written answer.'
  }
  if (answers.length !== ask.questions.length) {
    return `Answer all ${ask.questions.length} decisions together.`
  }
  // All or nothing: a partial answer never goes.
  const empty = answers.findIndex((answer) => answer.picks.length === 0 && !typed(answer))
  if (empty !== -1) {
    return `Decision ${empty + 1} needs an answer.`
  }
  for (const [index, question] of ask.questions.entries()) {
    const problem = decisionProblem(question, answers[index]!, index + 1)
    if (problem) {
      return problem
    }
  }
  return null
}

/** Why these answers can't answer this question, or null: the one admission rule the card's Submit and
 *  the host's write both apply. All decisions go in one answer, each answered; words are
 *  up to 2,000 characters each, and the answer as text up to the item comment limit. */
export function botItemAnswerProblem(
  ask: BotItemAsk | null,
  answers: readonly BotItemAnswer[]
): string | null {
  return shapeProblem(ask, answers) ?? botItemAnswerLengthProblem(ask, answers)
}

/** The length part of the admission rule, which the form shows while Send is off for it. */
export function botItemAnswerLengthProblem(
  ask: BotItemAsk | null,
  answers: readonly BotItemAnswer[]
): string | null {
  const long = answers.findIndex((answer) => typed(answer).length > L.answer)
  if (long !== -1) {
    return `Answer ${long + 1} is ${typed(answers[long]).length} characters; the limit is ${L.answer}.`
  }
  const total = botItemAnswerText(ask, answers).length
  return total > BOT_ITEM_LIMITS.text
    ? `Your answers come to ${total} characters together; the limit is ${BOT_ITEM_LIMITS.text}.`
    : null
}

/** Each decision and what it was answered with, as the receipt and the mail show them. */
export function botItemAnswerLines(
  ask: BotItemAsk | null,
  answers: readonly BotItemAnswer[]
): { question: string | null; answer: string; typed: boolean }[] {
  return answers.map((answer, index) => {
    const question = ask?.questions[index]
    const words = typed(answer)
    const picked = answer.picks.map((pick) => question?.options[pick]?.label ?? `#${pick + 1}`)
    return {
      question: question?.prompt ?? null,
      answer: [...picked, ...(words ? [picked.length > 0 ? `"${words}"` : words] : [])].join(', '),
      typed: words.length > 0 && picked.length === 0
    }
  })
}

/** The answer as plain text, for the comment's `text`. */
export function botItemAnswerText(
  ask: BotItemAsk | null,
  answers: readonly BotItemAnswer[]
): string {
  const lines = botItemAnswerLines(ask, answers)
  if (!ask) {
    return lines[0]?.answer ?? ''
  }
  return lines
    .map((line, index) => {
      const answer = !line.answer ? '(skipped)' : line.typed ? `"${line.answer}"` : line.answer
      return `${index + 1}. ${line.question} → ${answer}`
    })
    .join('\n')
}

/** The question as chat's question card takes it: each decision with its choices (the recommended one
 *  says so, as Claude's do), or a prose question's whole text with only the typed answer. */
export function botItemAskPrompt(text: string, ask: BotItemAsk | null): AskPrompt {
  if (!ask) {
    return { questions: [{ question: text, multiSelect: false, options: [] }] }
  }
  return {
    questions: ask.questions.map((question) => ({
      question: question.prompt,
      multiSelect: question.multi === true,
      options: question.options.map((option, index) => ({
        label: question.recommended === index ? `${option.label} (Recommended)` : option.label,
        ...(option.detail ? { description: option.detail } : {})
      }))
    }))
  }
}

/** The card's answer, one selection per decision, as the item stores it: picks, else the typed words. */
export function botItemAnswersOf(selections: readonly AskAnswerSelection[]): BotItemAnswer[] {
  return normalizeBotItemAnswers(
    selections.map((selection) => ({ picks: [...selection.indices], text: selection.other ?? '' }))
  )
}

/** The ask as plain text, for the question comment's `text`: the context, then each decision and its options. */
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

// Droid's AskUser tool takes a plain-text `questionnaire` string, not the
// `{questions: [...]}` object every other agent's ask tool uses. This is a
// faithful transcription of the grammar the shipped `droid` binary parses
// (markers, line-splitting, caps, and validation), so Orca's card renders
// exactly the questionnaire Droid's own selector is showing — and refuses the
// ones Droid itself rejects, where a rendered card could only mis-deliver.

import type { AskPrompt, AskQuestion } from './native-chat-ask-types'

const FENCED_BLOCK = /```(?:\w+)?\s*([\s\S]*?)```/m
const QUESTION_LINE = /^(?:(?:\d+[.)]|[-*•])\s*)?\[question\]\s*(.+?)\s*(\(multi\))?\s*$/i
const TOPIC_LINE = /^(?:(?:\d+[.)]|[-*•])\s*)?\[topic\]\s*(.+?)\s*$/i
const OPTION_LINE = /^(?:(?:\d+[.)]|[-*•])\s*)?\[option\]\s*(.+?)\s*$/i
const NUMBERED_LINE = /^(\d+)[.)]\s+(.+?)\s*(\(multi\))?\s*$/i
const MULTI_SUFFIX = /^(.*?)\s*\(multi\)\s*$/i
const MARKDOWN_HEADER = /^#+\s/
const FENCE_MARKER = /^```/
const CRAMMED_QUESTION_START = /^(?:\d+[.)]|[-*•])?\s*\[question\]/i
const CRAMMED_TRAILING_MARKER = /\[question\].*\[(topic|option)\]/i

const MAX_QUESTIONS = 10
const MIN_OPTIONS = 1
const MAX_OPTIONS = 10
/** Droid's fallback when a question declares no options at all. */
const IMPLIED_OPTIONS = ['Yes', 'No']

type Draft = {
  kind: 'explicit' | 'implicit'
  question: string
  topic?: string
  options: string[]
  multiSelect: boolean
}

/** Droid emits the topic as a single token, so its own tabs read `Model-choice`. */
function normalizeTopic(value: string): string {
  return value.trim().replaceAll(/\s+/g, '-')
}

/** A model can put `[question] … [topic] … [option] …` on one line; Droid breaks
 *  those apart before parsing, so the same line must split here too. */
function splitCrammedMarkers(line: string): string {
  if (!CRAMMED_QUESTION_START.test(line) || !CRAMMED_TRAILING_MARKER.test(line)) {
    return line
  }
  return line
    .replaceAll(/([.?!)])\s+\[(topic)\]/gi, '$1\n[$2]')
    .replaceAll(/([\w)])\s+\[(option)\]/g, '$1\n[$2]')
}

function questionnaireLines(raw: string): string[] {
  // A fenced block wins over the surrounding prose: models often wrap the
  // questionnaire in ``` and Droid parses only the fence's contents.
  const body = FENCED_BLOCK.exec(raw)?.[1] ?? raw
  const lines = body
    .split('\n')
    .map((line) => splitCrammedMarkers(line))
    .join('\n')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => {
      const trimmed = line.trim()
      return !MARKDOWN_HEADER.test(trimmed) && !FENCE_MARKER.test(trimmed)
    })
  const firstQuestion = lines.findIndex((line) => QUESTION_LINE.test(line.trim()))
  return firstQuestion > 0 ? lines.slice(firstQuestion) : lines
}

/** Close the open draft into a question, or reject the questionnaire the way
 *  Droid does (option count out of range, duplicate option labels). */
function closeDraft(draft: Draft, questions: AskQuestion[]): boolean {
  const options = draft.options.length === 0 ? [...IMPLIED_OPTIONS] : draft.options
  if (options.length < MIN_OPTIONS || options.length > MAX_OPTIONS) {
    return false
  }
  const seen = new Set<string>()
  for (const option of options) {
    const key = option.trim().toLowerCase()
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
  }
  questions.push({
    question: draft.question,
    ...(draft.topic ? { header: draft.topic } : {}),
    multiSelect: draft.multiSelect,
    options: options.map((label) => ({ label }))
  })
  return true
}

function nextNonEmptyLine(lines: readonly string[], from: number): string {
  for (let index = from; index < lines.length; index += 1) {
    const trimmed = lines[index]?.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return ''
}

/** Parse Droid's `{ questionnaire: string }` AskUser input. Returns null for any
 *  input Droid's own parser would reject, so no card is offered for a
 *  questionnaire whose selector is showing a format error instead of options. */
export function parseDroidQuestionnaire(input: unknown): AskPrompt | null {
  const raw = (input as { questionnaire?: unknown } | null)?.questionnaire
  if (typeof raw !== 'string') {
    return null
  }
  const lines = questionnaireLines(raw)
  const questions: AskQuestion[] = []
  let draft: Draft | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim()
    if (!trimmed) {
      continue
    }
    const question = QUESTION_LINE.exec(trimmed)
    if (question) {
      if (draft && !closeDraft(draft, questions)) {
        return null
      }
      draft = null
      const text = (question[1] ?? '').trim()
      if (!text || questions.length >= MAX_QUESTIONS) {
        return null
      }
      draft = { kind: 'explicit', question: text, options: [], multiSelect: !!question[2] }
      continue
    }
    const topic = TOPIC_LINE.exec(trimmed)
    if (topic) {
      const text = (topic[1] ?? '').trim()
      if (!draft || !text) {
        return null
      }
      draft.topic = normalizeTopic(text)
      continue
    }
    const option = OPTION_LINE.exec(trimmed)
    if (option) {
      const text = (option[1] ?? '').trim()
      if (!draft || !text || draft.options.length >= MAX_OPTIONS) {
        return null
      }
      draft.options.push(text)
      continue
    }
    // A wrapped question keeps accumulating until its first topic/option line.
    if (draft?.kind === 'explicit' && !draft.topic && draft.options.length === 0) {
      const multi = MULTI_SUFFIX.exec(trimmed)
      if (multi) {
        draft.multiSelect = true
        if (multi[1]) {
          draft.question += `\n${multi[1]}`
        }
      } else {
        draft.question += `\n${trimmed}`
      }
      continue
    }
    // `1. Which one?` opens a question only when its own topic/option lines follow.
    const numbered = NUMBERED_LINE.exec(trimmed)
    if (!numbered) {
      continue
    }
    const following = nextNonEmptyLine(lines, index + 1)
    if (!TOPIC_LINE.test(following) && !OPTION_LINE.test(following)) {
      continue
    }
    if (draft && !closeDraft(draft, questions)) {
      return null
    }
    draft = null
    if (questions.length >= MAX_QUESTIONS) {
      return null
    }
    draft = {
      kind: 'implicit',
      question: (numbered[2] ?? '').trim(),
      options: [],
      multiSelect: !!numbered[3]
    }
  }

  if (draft && !closeDraft(draft, questions)) {
    return null
  }
  return questions.length > 0 ? { questions } : null
}

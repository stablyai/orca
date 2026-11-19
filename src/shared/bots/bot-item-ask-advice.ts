// Why a bot's Needs you ask may be hard for its owner to read at a glance, as one tip back to the bot.
// Advice only: the ask is already posted as written. Linear and bounded: one pass over a prefix, with
// fixed-width patterns; code, links and paths are skipped, since the bot marked or linked them.
import type { BotItemAsk } from './bot-item-ask'

export type BotItemAskAdviceCode =
  | 'prose_choices'
  | 'no_question'
  | 'long_question'
  | 'long_context'
  | 'jargon'

export type BotItemAskAdvice = {
  /** Every code that fired, in priority order. */
  codes: BotItemAskAdviceCode[]
  /** The first code's tip only. */
  tip: string
}

const SCAN_LIMIT = 8_000
const QUESTION_LIMIT = 140
const LEAD_LIMIT = 300
const CONTEXT_LIMIT = 300
const CONTEXT_LINES = 5
const PIECE_LIMIT = 200

const TIPS: Record<BotItemAskAdviceCode, string> = {
  prose_choices: 'Give the choices as buttons with --ask and --option, not in the text.',
  no_question: 'Lead with the question itself, ending in a question mark.',
  long_question: 'Keep the question to one line under 140 characters; put the why in --comment.',
  long_context: 'Keep --comment to 5 short lines or a link.',
  jargon: 'Say in plain words what each hash or ID is, or link it instead.'
}

/** Highest priority first: only the first code's tip shows. */
const ORDER: readonly BotItemAskAdviceCode[] = [
  'prose_choices',
  'no_question',
  'long_question',
  'long_context',
  'jargon'
]

// Choices spelled out in prose: "Reply **yes**", "Reply A or B", "Options: (a) …", "A) …", "Option 2",
// "Pick one:", "A/B/C", "(recommended)".
const PROSE_CHOICES = [
  /\b(?:reply|answer|say)\s+(?:with\s+)?(?:e\.g\.\s*)?[*"“'`]/i,
  // Capital letters only, so "reply with a summary" is not a choice.
  /\b(?:[Rr]eply|[Aa]nswer|[Ss]ay)\s+(?:with\s+)?[A-D1-4](?=[\s,.;]|$)/,
  /\b(?:pick(?: one)?|choose|options?)\s*:/i,
  /\(\s*[a-dA-D1-4]\s*\)\s/,
  /(?:^|\s)[A-D]\)\s/m,
  /\bOption [A-D1-4]\b/,
  /\b[A-D]\/[A-D]\b/,
  /\(recommended\)|,\s*recommended\)/i
]

const HEX_RUN = /[0-9a-f]{12,}/g
const INTERNAL_ID = /^(?:ctx|task|msg|wf|run)_[0-9a-z]{8,}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// A long lowercase run into a capital or digit ("questionalreadyNeedsyou"), or one past real English
// words ("internationalization" is 20); camelCase identifiers keep their lowercase runs short.
const FUSED = /[a-z]{12}[A-Z0-9]|[a-z]{22}/
const PIECE_SPLIT = /[/+,;:()[\]{}<>"'“”‘’|=*]+/
const END_MARKS = /^[.!?…-]+|[.!?…-]+$/g

/** A word without its Markdown link target, or nothing for a URL. Linear in the word. */
function shownWord(word: string): string {
  const target = word.indexOf('](')
  const shown = target === -1 ? word : word.slice(0, target + 1)
  return shown.includes('://') ? ' ' : shown
}

/** The words a reader sees: no code, link targets or URLs. Every pass is linear in the text. */
function prose(text: string): string {
  return text
    .slice(0, SCAN_LIMIT)
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\S+/g, shownWord)
}

/** A path, even wrapped in brackets or quotes: the bot pointed at it, so its ids are fine. */
function isPath(token: string): boolean {
  const bare = token.replace(/^[([{<"'“‘]+/, '')
  return (
    bare.startsWith('/') ||
    bare.startsWith('~/') ||
    bare.startsWith('./') ||
    bare.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(bare)
  )
}

function hasHash(piece: string): boolean {
  for (const match of piece.matchAll(HEX_RUN)) {
    if (/\d/.test(match[0]) && /[a-f]/.test(match[0])) {
      return true
    }
  }
  return false
}

/** Hashes, internal ids, or two or more run-together words: things the owner can't decode. */
function hasJargon(words: string): boolean {
  let fused = 0
  for (const token of words.split(/\s+/)) {
    if (isPath(token)) {
      continue
    }
    if (token.includes('orca_session_id:')) {
      return true
    }
    for (const raw of token.split(PIECE_SPLIT)) {
      const piece = raw.slice(0, PIECE_LIMIT).replace(END_MARKS, '')
      if (piece.length < 8) {
        continue
      }
      if (INTERNAL_ID.test(piece) || UUID.test(piece) || hasHash(piece)) {
        return true
      }
      if (FUSED.test(piece) && ++fused >= 2) {
        return true
      }
    }
  }
  return false
}

/** The first paragraph's length: up to a blank line or the first list item. */
function leadLength(text: string): number {
  const rest = text.trimStart()
  const end = rest.search(/\n\s*\n|\n\s*(?:[-*]|\d+[.)])\s/)
  return end < 0 ? rest.length : end
}

/** A tip for a Needs you write, or null when it reads fine. `ask` wins over `comment`, which then
 *  only repeats the ask for older hosts. */
export function botItemAskAdvice({
  comment,
  ask
}: {
  comment?: string
  ask?: BotItemAsk
}): BotItemAskAdvice | null {
  const found = new Set<BotItemAskAdviceCode>()
  let words: string
  if (ask) {
    const context = ask.context?.trim() ?? ''
    const prompts = ask.questions.map((question) => question.prompt)
    if (prompts.some((prompt) => !prompt.includes('?'))) {
      found.add('no_question')
    }
    if (prompts.some((prompt) => prompt.length > QUESTION_LIMIT)) {
      found.add('long_question')
    }
    const lines = context.split('\n').filter((line) => line.trim()).length
    if (context.length > CONTEXT_LIMIT || lines > CONTEXT_LINES) {
      found.add('long_context')
    }
    const options = ask.questions.flatMap((question) =>
      question.options.flatMap((option) => [option.label, option.detail ?? ''])
    )
    words = prose([context, ...prompts, ...options].join('\n'))
  } else {
    const text = comment ?? ''
    words = prose(text)
    if (PROSE_CHOICES.some((pattern) => pattern.test(words))) {
      found.add('prose_choices')
    }
    if (!words.includes('?')) {
      found.add('no_question')
    }
    if (leadLength(text.slice(0, SCAN_LIMIT)) > LEAD_LIMIT) {
      found.add('long_question')
    }
  }
  if (hasJargon(words)) {
    found.add('jargon')
  }
  const codes = ORDER.filter((code) => found.has(code))
  if (codes.length === 0) {
    return null
  }
  return {
    codes,
    tip: `Posted. Tip: ${TIPS[codes[0]!]} Set Needs you again if you rewrite it.`
  }
}

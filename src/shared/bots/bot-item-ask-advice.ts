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
  prose_choices: 'Give the choices as --option values after --ask, so they show as quick replies.',
  no_question: 'Lead with the question itself, ending in a question mark.',
  long_question: 'Keep the question to one line under 140 characters; put the why in --comment.',
  long_context:
    'Keep --comment to 5 short lines or a link; more context goes in the same call with --comment-file, never in a separate comment.',
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

// Choices spelled out in prose: "Reply **yes**", "Reply A or B", "Options: (a) ...", "A) ...", "Option 2",
// "Pick one:", "A/B/C", "(recommended)".
const PROSE_CHOICES = [
  /\b(?:reply|answer|say)\s+(?:with\s+)?(?:e\.g\.\s*)?[*"\u201c'`]/i,
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
const PIECE_SPLIT = /[/+,;:()[\]{}<>"'\u201c\u201d\u2018\u2019|=*`]+/
const END_MARKS = /^[.!?\u2026-]+|[.!?\u2026-]+$/g

// "Reply A or B" in any case; the letter must be a capital or a digit, so "reply with a summary" is
// not option A.
const REPLY_WITH = /\b(?:reply|answer|say)\s+(?:with\s+)?([a-d1-4])(?=[\s,.;]|$)/gi

function repliesWithOption(words: string): boolean {
  for (const match of words.matchAll(REPLY_WITH)) {
    if (match[1] !== match[1]!.toLowerCase() || /\d/.test(match[1]!)) {
      return true
    }
  }
  return false
}

function hasProseChoices(words: string): boolean {
  return PROSE_CHOICES.some((pattern) => pattern.test(words)) || repliesWithOption(words)
}

const URL_END = new Set(['.', ',', ';', ':', '!', '?', ')'])
const SCHEME = /[A-Za-z0-9+.-]/
const TARGET_STOP = /[\s()[\]]/

type TickRun = { start: number; end: number; line: number }

/** Without closed code: a run of backticks hides text only up to the next run of the same length,
 *  on the same line for one or two ticks (a span), anywhere for three or more (a fence). A run with
 *  no such closer is plain text. Linear. */
function withoutCode(text: string): string {
  const runs: TickRun[] = []
  let line = 0
  for (let i = 0; i < text.length;) {
    if (text[i] !== '`') {
      line += text[i] === '\n' ? 1 : 0
      i += 1
      continue
    }
    const start = i
    while (i < text.length && text[i] === '`') {
      i += 1
    }
    runs.push({ start, end: i, line })
  }
  // Each run's next run of the same length.
  const closer: number[] = []
  const nextOfLength = new Map<number, number>()
  for (let k = runs.length - 1; k >= 0; k -= 1) {
    const length = runs[k]!.end - runs[k]!.start
    closer[k] = nextOfLength.get(length) ?? -1
    nextOfLength.set(length, k)
  }
  let shown = ''
  let at = 0
  for (const [k, run] of runs.entries()) {
    const close = closer[k] === -1 ? null : runs[closer[k]!]!
    if (run.start < at || !close || (run.end - run.start < 3 && close.line !== run.line)) {
      continue
    }
    shown += `${text.slice(at, run.start)} `
    at = close.end
  }
  return shown + text.slice(at)
}

/** Without closed link targets: `[label](target)` shows as `[label]` when the label's `[` is on the
 *  same line and the target has no spaces, brackets or parentheses. Anything else is plain text.
 *  Linear: a target's scan stops at the next `]` or `(`, so scans never overlap. */
function withoutLinkTargets(text: string): string {
  let shown = ''
  let at = 0
  let labelOpen = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (char === '\n') {
      labelOpen = false
    } else if (char === '[') {
      labelOpen = true
    } else if (char === ']') {
      const isLabel = labelOpen
      labelOpen = false
      if (!isLabel || text[i + 1] !== '(') {
        continue
      }
      let end = i + 2
      while (end < text.length && !TARGET_STOP.test(text[end]!)) {
        end += 1
      }
      if (text[end] === ')') {
        shown += text.slice(at, i + 1)
        at = end + 1
        i = end
      }
    }
  }
  return shown + text.slice(at)
}

/** A word without its URL (from the scheme to the word's end), keeping the text before it and the
 *  punctuation after it. Linear in the word. */
function withoutUrl(word: string): string {
  const slashes = word.indexOf('://')
  if (slashes === -1) {
    return word
  }
  let start = slashes
  while (start > 0 && SCHEME.test(word[start - 1]!)) {
    start -= 1
  }
  let end = word.length
  while (end > slashes && URL_END.has(word[end - 1]!)) {
    end -= 1
  }
  return `${word.slice(0, start)} ${word.slice(end)}`
}

/** The words a reader sees: closed code, closed link targets and URLs are hidden; nothing else is.
 *  Every pass is linear in the text. */
function prose(text: string): string {
  return withoutLinkTargets(withoutCode(text.slice(0, SCAN_LIMIT))).replace(/\S+/g, withoutUrl)
}

/** A path, even wrapped in brackets or quotes: the bot pointed at it, so its ids are fine. */
function isPath(token: string): boolean {
  const bare = token.replace(/^[([{<"'\u201c\u2018`]+/, '')
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
    // A question mark inside a URL or code is not the question's own.
    if (prompts.some((prompt) => !prose(prompt).includes('?'))) {
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
    // Each field is masked on its own, so code never pairs across two of them.
    const written = [context, ...prompts].map(prose)
    // Choices the bot wrote into its question or context rather than as buttons.
    if (hasProseChoices(written.join('\n'))) {
      found.add('prose_choices')
    }
    words = [...written, ...options.map(prose)].join('\n')
  } else {
    const text = comment ?? ''
    words = prose(text)
    if (hasProseChoices(words)) {
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

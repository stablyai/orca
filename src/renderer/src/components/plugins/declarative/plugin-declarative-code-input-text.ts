import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'

type CodeInputProps = PluginDeclarativeProps<'CodeInput'>
export type PluginCodeInputCompletion = NonNullable<CodeInputProps['completions']>[number]
export type PluginCodeInputDiagnostic = NonNullable<CodeInputProps['diagnostics']>[number]

// `$` and `.` belong to the word so operators (`$gt`) and dotted paths (`a.b`) complete whole.
const WORD_CHAR = /[\p{L}\p{N}_$.]/u
const MAX_SHOWN = 50

export function isCompletionWordChar(character: string): boolean {
  return WORD_CHAR.test(character)
}

/** The word that ends at `cursor`, which a completion replaces. */
export function completionWordAt(text: string, cursor: number): { from: number; word: string } {
  let from = cursor
  while (from > 0 && isCompletionWordChar(text[from - 1]!)) {
    from -= 1
  }
  return { from, word: text.slice(from, cursor) }
}

/**
 * Whether `cursor` sits inside a string opened by one of `quotes`. A backslash escapes the next
 * character, and a line break ends any string but a backtick one, as in JavaScript.
 */
export function insideString(text: string, cursor: number, quotes: string | undefined): boolean {
  if (!quotes) {
    return false
  }
  let open: string | null = null
  for (let index = 0; index < cursor; index += 1) {
    const character = text[index]!
    if (open === null) {
      open = quotes.includes(character) ? character : null
    } else if (character === '\\') {
      index += 1
    } else if (character === open || (character === '\n' && open !== '`')) {
      open = null
    }
  }
  return open !== null
}

/** Prefix matches first, then matches anywhere, each in the plugin's order; never the word itself. */
export function matchCompletions(
  completions: readonly PluginCodeInputCompletion[],
  word: string
): PluginCodeInputCompletion[] {
  const needle = word.toLowerCase()
  const prefix: PluginCodeInputCompletion[] = []
  const inside: PluginCodeInputCompletion[] = []
  for (const item of completions) {
    if (item.label === word && (item.insert ?? item.label) === word) {
      continue
    }
    const at = item.label.toLowerCase().indexOf(needle)
    if (at === 0) {
      prefix.push(item)
    } else if (at > 0) {
      inside.push(item)
    }
  }
  return [...prefix, ...inside].slice(0, MAX_SHOWN)
}

export type CodeInputSegment = {
  text: string
  tone?: 'danger' | 'warning'
  /** The caret sits at the start of this segment. */
  caret?: boolean
}

/**
 * `text` cut at each diagnostic edge and at the caret. Overlapping ranges keep the earlier one; an
 * empty range marks the character after it, or a space past the end.
 */
export function codeInputSegments(
  text: string,
  diagnostics: readonly PluginCodeInputDiagnostic[],
  caret: number
): CodeInputSegment[] {
  const ranges: { from: number; to: number; tone: 'danger' | 'warning' }[] = []
  for (const diagnostic of [...diagnostics].sort((a, b) => a.from - b.from)) {
    const from = Math.min(diagnostic.from, text.length)
    const to = Math.max(from + 1, Math.min(diagnostic.to, text.length))
    const last = ranges.at(-1)
    if (last && from < last.to) {
      continue
    }
    ranges.push({ from, to, tone: diagnostic.tone ?? 'danger' })
  }
  const padded = ranges.some((range) => range.to > text.length) ? `${text} ` : text
  const cuts = new Set([0, padded.length, Math.min(caret, text.length)])
  for (const range of ranges) {
    cuts.add(range.from)
    cuts.add(range.to)
  }
  const edges = [...cuts].sort((a, b) => a - b)
  const segments: CodeInputSegment[] = []
  for (let index = 0; index < edges.length - 1; index += 1) {
    const from = edges[index]!
    const range = ranges.find((each) => each.from <= from && from < each.to)
    segments.push({
      text: padded.slice(from, edges[index + 1]),
      ...(range ? { tone: range.tone } : {}),
      ...(from === caret ? { caret: true } : {})
    })
  }
  if (caret >= padded.length) {
    segments.push({ text: '', caret: true })
  }
  return segments
}

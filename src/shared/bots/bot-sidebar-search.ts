// The Bots section's search: a bot or group matches by name, a bot also by its purpose.
// Case- and accent-insensitive substring or word-prefix matching, with no typo tolerance:
// in a filter that hides everything else, a near-miss reads as a wrong result.

export type BotSearchRange = { start: number; end: number }

/** Text folded for matching, with each folded unit's source span; null spans mean the same offsets. */
export type FoldedBotSearchText = {
  folded: string
  starts: readonly number[] | null
  ends: readonly number[] | null
}

// Printable ASCII folds by plain lowercasing with no change in length.
const PRINTABLE_ASCII = /^[ -~]*$/
const COMBINING_MARK = /\p{M}/u
const COMBINING_MARKS = /\p{M}/gu
const WORD = /[\p{L}\p{N}]+/gu
const WHITESPACE = /\s+/u

function foldCluster(cluster: string): string {
  // Per code point, so no letter's case depends on its neighbours; final sigma folds as sigma.
  return cluster.normalize('NFD').replace(COMBINING_MARKS, '').toLowerCase().replace(/ς/g, 'σ')
}

/** Folds case and accents one character (with its combining marks) at a time, keeping where each came from. */
export function foldBotSearchText(text: string): FoldedBotSearchText {
  if (PRINTABLE_ASCII.test(text)) {
    return { folded: text.toLowerCase(), starts: null, ends: null }
  }
  let folded = ''
  const starts: number[] = []
  const ends: number[] = []
  let index = 0
  while (index < text.length) {
    const codePoint = text.codePointAt(index)!
    let end = index + (codePoint > 0xffff ? 2 : 1)
    while (end < text.length) {
      const next = text.codePointAt(end)!
      if (!COMBINING_MARK.test(String.fromCodePoint(next))) {
        break
      }
      end += next > 0xffff ? 2 : 1
    }
    const chunk = foldCluster(text.slice(index, end))
    for (let unit = 0; unit < chunk.length; unit += 1) {
      starts.push(index)
      ends.push(end)
    }
    folded += chunk
    index = end
  }
  return { folded, starts, ends }
}

function sourceRange(text: FoldedBotSearchText, start: number, end: number): BotSearchRange {
  if (!text.starts || !text.ends) {
    return { start, end }
  }
  return { start: text.starts[start]!, end: text.ends[end - 1]! }
}

/** A query folded once per keystroke: the whole phrase and its words. */
export type BotSearchQuery = { phrase: string; tokens: string[] }

/** Null for a query with nothing to match. */
export function parseBotSearchQuery(query: string): BotSearchQuery | null {
  const phrase = foldBotSearchText(query.trim()).folded
  if (!phrase) {
    return null
  }
  return { phrase, tokens: phrase.split(WHITESPACE).filter(Boolean) }
}

type IndexedText = FoldedBotSearchText & { wordStarts: number[] }

function indexText(text: string): IndexedText {
  const folded = foldBotSearchText(text)
  const wordStarts = [...folded.folded.matchAll(WORD)].map((match) => match.index)
  return { ...folded, wordStarts }
}

function matchIndexed(text: IndexedText, query: BotSearchQuery): BotSearchRange[] | null {
  const at = text.folded.indexOf(query.phrase)
  if (at !== -1) {
    return [sourceRange(text, at, at + query.phrase.length)]
  }
  if (query.tokens.length < 2) {
    return null
  }
  // Every word of the query starts a word of the text, in any order: "rev eng" finds "Eng - Reviewer".
  const ranges: BotSearchRange[] = []
  for (const token of query.tokens) {
    const start = text.wordStarts.find((wordStart) => text.folded.startsWith(token, wordStart))
    if (start === undefined) {
      return null
    }
    ranges.push(sourceRange(text, start, start + token.length))
  }
  return mergeBotSearchRanges(ranges)
}

/** Where `query` matches `text`, in `text`'s own offsets; null when it doesn't. */
export function matchBotSearchText(text: string, query: string): BotSearchRange[] | null {
  const parsed = parseBotSearchQuery(query)
  return parsed ? matchIndexed(indexText(text), parsed) : null
}

/** Sorted, with overlapping or touching ranges joined, for marking. */
export function mergeBotSearchRanges(ranges: readonly BotSearchRange[]): BotSearchRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start)
  const merged: BotSearchRange[] = []
  for (const range of sorted) {
    const last = merged.at(-1)
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }
  return merged
}

type SearchableEntry =
  | { kind: 'bot'; id: string; bot: { name: string; paused: boolean } }
  | { kind: 'group'; id: string; group: { name: string } }

export type BotSearchMatch<E> = {
  entry: E
  /** Marks in the name; empty when only the purpose matched. */
  nameRanges: BotSearchRange[]
  /** Set when the purpose matched and the name didn't. */
  purpose: { text: string; ranges: BotSearchRange[] } | null
}

export type BotSidebarSearchResult<E> = {
  /** Name matches, then purpose-only matches, each in the list's own order. */
  matches: BotSearchMatch<E>[]
  /** Paused bots the list leaves out that match by name. */
  hiddenPausedMatches: number
}

type IndexedEntry<E> = {
  entry: E
  name: IndexedText
  purpose: { text: string; indexed: IndexedText } | null
}

/** Names are indexed once; each purpose is refreshed only when its reader supplies different text. */
export function createBotSidebarSearchIndex<E extends SearchableEntry>({
  shown,
  all,
  purposeOf
}: {
  /** The entries as the list shows them, in its order. */
  shown: readonly E[]
  /** Every entry, filters ignored, for the hidden paused bots that match. */
  all: readonly E[]
  purposeOf: (entry: E) => string | null
}): (query: string, currentPurposeOf?: (entry: E) => string | null) => BotSidebarSearchResult<E> {
  const nameOf = (entry: E): string => (entry.kind === 'bot' ? entry.bot.name : entry.group.name)
  const indexed: IndexedEntry<E>[] = shown.map((entry) => {
    return {
      entry,
      name: indexText(nameOf(entry)),
      purpose: null
    }
  })
  const shownIds = new Set(shown.map((entry) => entry.id))
  const hiddenPaused = all
    .filter((entry) => entry.kind === 'bot' && entry.bot.paused && !shownIds.has(entry.id))
    .map((entry) => indexText(nameOf(entry)))
  return (query, currentPurposeOf = purposeOf) => {
    const parsed = parseBotSearchQuery(query)
    if (!parsed) {
      return { matches: [], hiddenPausedMatches: 0 }
    }
    const byName: BotSearchMatch<E>[] = []
    const byPurpose: BotSearchMatch<E>[] = []
    for (const item of indexed) {
      const { entry, name } = item
      const nameRanges = matchIndexed(name, parsed)
      if (nameRanges) {
        byName.push({ entry, nameRanges, purpose: null })
        continue
      }
      const text = entry.kind === 'bot' ? currentPurposeOf(entry) : null
      if (text !== (item.purpose?.text ?? null)) {
        item.purpose = text ? { text, indexed: indexText(text) } : null
      }
      const { purpose } = item
      const purposeRanges = purpose ? matchIndexed(purpose.indexed, parsed) : null
      if (purpose && purposeRanges) {
        byPurpose.push({
          entry,
          nameRanges: [],
          purpose: { text: purpose.text, ranges: purposeRanges }
        })
      }
    }
    return {
      matches: [...byName, ...byPurpose],
      hiddenPausedMatches: hiddenPaused.filter((name) => matchIndexed(name, parsed) !== null).length
    }
  }
}

/** Text split into plain and marked parts. */
export function splitBotSearchText(
  text: string,
  ranges: readonly BotSearchRange[]
): { text: string; marked: boolean }[] {
  const parts: { text: string; marked: boolean }[] = []
  let at = 0
  for (const { start, end } of mergeBotSearchRanges(ranges)) {
    if (start > at) {
      parts.push({ text: text.slice(at, start), marked: false })
    }
    parts.push({ text: text.slice(start, end), marked: true })
    at = end
  }
  if (at < text.length) {
    parts.push({ text: text.slice(at), marked: false })
  }
  return parts
}

// How much of a purpose to keep before its first match, so a one-line snippet shows the match.
const SNIPPET_LEAD = 24

/** A purpose cut to start shortly before its first match, at a word, with "…" when cut. */
export function botPurposeSnippet(
  text: string,
  ranges: readonly BotSearchRange[]
): { text: string; ranges: BotSearchRange[] } {
  const first = ranges[0]
  if (!first || first.start <= SNIPPET_LEAD) {
    return { text, ranges: [...ranges] }
  }
  const from = first.start - SNIPPET_LEAD
  const space = text.indexOf(' ', from)
  let cut = space !== -1 && space < first.start ? space + 1 : from
  // Never start on the second half of a surrogate pair.
  if (/[\udc00-\udfff]/.test(text[cut] ?? '')) {
    cut += 1
  }
  // The "…" takes one unit in front.
  const shift = cut - 1
  return {
    text: `…${text.slice(cut)}`,
    ranges: ranges.map(({ start, end }) => ({
      start: start - shift,
      end: end - shift
    }))
  }
}

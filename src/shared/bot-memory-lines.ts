// MEMORY.md as the owner sees it: one fact per list line, optionally dated, everything else kept byte for byte.
// Orca, not the bot, writes where a fact came from after " · from: "; plain text, so any reader shows it.

/** Lines of MEMORY.md a session loads at start; the rest stays on disk for the bot to read. */
export const BOT_MEMORY_INDEX_LINE_CAP = 200

export type BotMemoryFact = {
  /** Index into the file's lines, so an edit touches only this line. */
  line: number
  /** `YYYY-MM-DD`, when the line starts with one. */
  date: string | null
  text: string
  /** Where Orca saw it come from; null for the owner's own and the owner's chat. */
  source: string | null
}

export const BOT_MEMORY_SOURCE_SEPARATOR = ' · from: '

const FACT_LINE = /^(\s*[-*]\s+)(.*)$/
/** The how-to line a new bot's MEMORY.md starts with (bot-home.ts), not a fact. */
export const BOT_MEMORY_SEED_INTRO =
  'One line per fact, newest first. Longer notes go in memory/<topic>.md.'
// Headings ("# x", never "#123"), table rows, HTML comments and rules (---, ***, ===, * * *).
const NOT_A_FACT = /^(?:#{1,6}(?:\s|$)|\||<!--|[\s*_=:-]+$)/
const FENCE = /^\s*(`{3,}|~{3,})/
const DATED_TEXT = /^(\d{4}-\d{2}-\d{2})(?:\s*[:\u2013\u2014-]\s*|\s+)(.*)$/

function splitLines(text: string): { lines: string[]; eol: string } {
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

/** The lines of MEMORY.md a session loads, and how many past the cap it leaves on disk. */
export function loadedBotMemoryLines(
  text: string,
  cap = BOT_MEMORY_INDEX_LINE_CAP
): { lines: string[]; omitted: number } {
  const lines = text.trimEnd().split(/\r?\n/)
  return { lines: lines.slice(0, cap), omitted: Math.max(0, lines.length - cap) }
}

/** Counted as the session loader counts them, so the gauge matches what the bot sees. */
export function countBotMemoryLines(text: string): number {
  const trimmed = text.trimEnd()
  return trimmed === '' ? 0 : trimmed.split(/\r?\n/).length
}

type FactParts = Omit<BotMemoryFact, 'line'> & { prefix: string }

/** Each line's fact, or null: a line in a code fence is never one, whatever it looks like. */
function lineFacts(lines: readonly string[]): (FactParts | null)[] {
  // The open fence, if any: it closes only on the same character at least as many times.
  let open: string | null = null
  return lines.map((raw) => {
    const fence = FENCE.exec(raw)?.[1]
    if (fence && (open === null || (fence[0] === open[0] && fence.length >= open.length))) {
      open = open === null ? fence : null
      return null
    }
    return open !== null ? null : factParts(raw)
  })
}

export function parseBotMemoryFacts(text: string): BotMemoryFact[] {
  const facts: BotMemoryFact[] = []
  const { lines } = splitLines(text)
  const parts = lineFacts(lines)
  lines.forEach((_raw, line) => {
    const fact = parts[line]
    if (fact) {
      const { prefix: _prefix, ...read } = fact
      facts.push({ line, ...read })
    }
  })
  return facts
}

function factParts(raw: string): FactParts | null {
  // A list line, or any other line with words in it: every line of MEMORY.md is one fact.
  const plain = raw.trim()
  if (plain === BOT_MEMORY_SEED_INTRO || NOT_A_FACT.test(plain) || FENCE.test(plain)) {
    return null
  }
  const listed = FACT_LINE.exec(raw)
  const body = listed ? listed[2]?.trim() : plain
  if (!body) {
    return null
  }
  const prefix = listed ? listed[1] : (/^\s*/.exec(raw)?.[0] ?? '')
  const dated = DATED_TEXT.exec(body)
  const text = dated ? dated[2].trim() : body
  const at = text.lastIndexOf(BOT_MEMORY_SOURCE_SEPARATOR)
  return {
    prefix,
    date: dated?.[1] ?? null,
    text: at > 0 ? text.slice(0, at).trim() : text,
    source: at > 0 ? text.slice(at + BOT_MEMORY_SOURCE_SEPARATOR.length).trim() || null : null
  }
}

/**
 * Orca's marks on the lines `after` has that `before` didn't. A fact `before` already had, however
 * the line was rewritten, keeps its old mark or none; a new one gets `label` (null: the owner's).
 * Whatever source a changed line claims is dropped either way.
 */
export function tagBotMemoryChanges(before: string, after: string, label: string | null): string {
  const earlier = new Map<string, number>()
  const known = new Map<string, string | null>()
  const was = splitLines(before).lines
  lineFacts(was).forEach((fact, index) => {
    earlier.set(was[index], (earlier.get(was[index]) ?? 0) + 1)
    if (fact && !known.has(factKey(fact.text))) {
      known.set(factKey(fact.text), fact.source)
    }
  })
  const { lines, eol } = splitLines(after)
  const facts = lineFacts(lines)
  return lines
    .map((raw, index) => {
      const seen = earlier.get(raw) ?? 0
      earlier.set(raw, seen - 1)
      const fact = seen > 0 ? null : facts[index]
      // A separator lookalike left in the text would read as a source.
      const text = fact ? oneLine(defusedSeparators(fact.text)) : ''
      if (!fact || !text) {
        return raw
      }
      const kept = known.get(factKey(fact.text))
      return factLine(fact.prefix, fact.date, text, kept === undefined ? label : kept)
    })
    .join(eol)
}

/** `text` without the lines stating `fact`, given as its words or as a whole line. */
export function dropBotMemoryFact(text: string, fact: string): { text: string; dropped: number } {
  const wanted = factParts(`- ${fact.trim().replace(/^[-*]\s+/, '')}`)
  const key = wanted ? factKey(wanted.text) : ''
  const { lines, eol } = splitLines(text)
  const facts = lineFacts(lines)
  const kept = lines.filter((_raw, index) => {
    const parts = facts[index]
    return key === '' || !parts || factKey(parts.text) !== key
  })
  return { text: kept.join(eol), dropped: lines.length - kept.length }
}

/** A fact line, and the non-blank line it followed (null: the top of the file). */
export type BotMemoryLine = { line: string; after: string | null }

/** What a write did to MEMORY.md's facts, by their words: dates, marks and spacing aside. */
export type BotMemoryChange = { added: BotMemoryLine[]; removed: BotMemoryLine[] }

export function isEmptyBotMemoryChange(change: BotMemoryChange): boolean {
  return change.added.length === 0 && change.removed.length === 0
}

function rawFactKey(raw: string): string | null {
  const fact = factParts(raw)
  return fact ? factKey(fact.text) : null
}

/** Each line's fact key in `text`, fences read: null for a line that states no fact. */
function lineKeys(lines: readonly string[]): (string | null)[] {
  return lineFacts(lines).map((fact) => (fact ? factKey(fact.text) : null))
}

/** The facts `text` states, by their words. */
export function botMemoryFactKeys(text: string): Set<string> {
  return new Set(lineKeys(splitLines(text).lines).flatMap((key) => key ?? []))
}

export function botMemoryLineKey({ line }: BotMemoryLine): string | null {
  return rawFactKey(line)
}

/** Both changes as one, each fact once. */
export function mergeBotMemoryChanges(a: BotMemoryChange, b: BotMemoryChange): BotMemoryChange {
  const unique = (lines: BotMemoryLine[]): BotMemoryLine[] => {
    const seen = new Set<string | null>()
    return lines.filter((line) => {
      const key = rawFactKey(line.line)
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
  }
  return {
    added: unique([...a.added, ...b.added]),
    removed: unique([...a.removed, ...b.removed])
  }
}

/** Whether only fact lines differ (blank lines aside): what a `BotMemoryChange` can say in full. */
export function onlyBotMemoryFactsChanged(before: string, after: string): boolean {
  const others = (text: string): string[] => {
    const { lines } = splitLines(text)
    const keys = lineKeys(lines)
    return lines.flatMap((raw, index) =>
      raw.trim() !== '' && keys[index] === null ? [raw.trim()] : []
    )
  }
  const [a, b] = [others(before), others(after)]
  return a.length === b.length && a.every((line, index) => line === b[index])
}

/** The facts `after` has that `before` hasn't, and the reverse. */
export function botMemoryChange(before: string, after: string): BotMemoryChange {
  const only = (from: string, other: string): BotMemoryLine[] => {
    const keys = new Set(lineKeys(splitLines(other).lines))
    const lines: BotMemoryLine[] = []
    let previous: string | null = null
    const rows = splitLines(from).lines
    const rowKeys = lineKeys(rows)
    for (const [index, raw] of rows.entries()) {
      const key = rowKeys[index]
      if (key !== null && !keys.has(key)) {
        lines.push({ line: raw, after: previous })
      }
      previous = raw.trim() === '' ? previous : raw
    }
    return lines
  }
  return { added: only(after, before), removed: only(before, after) }
}

/** `text` with `change` made: its removed facts gone, and each added one not already there after
 *  the line it followed, or at the end when that line is gone. */
export function applyBotMemoryChange(text: string, change: BotMemoryChange): string {
  const gone = new Set(change.removed.map(({ line }) => rawFactKey(line)))
  const { lines, eol } = splitLines(text)
  const keys = lineKeys(lines)
  const kept = lines.filter((_raw, index) => {
    const key = keys[index]
    return key === null || !gone.has(key)
  })
  const present = new Set(lineKeys(kept))
  for (const { line, after } of change.added) {
    const key = rawFactKey(line)
    if (key === null || present.has(key)) {
      continue
    }
    present.add(key)
    const anchor = after === null ? -1 : kept.lastIndexOf(after)
    const end = kept.findLastIndex((raw) => raw.trim() !== '') + 1
    kept.splice(after === null || anchor !== -1 ? anchor + 1 : end, 0, line)
  }
  return kept.join(eol)
}

/** A source's words and its link, as Orca writes them: "Slack, Dana <https://…>". */
export function botMemorySourceLink(source: string): { text: string; url: string | null } {
  const linked = /^(.*?)\s*<(https:\/\/[^\s<>]+)>$/.exec(source)
  return linked ? { text: linked[1], url: linked[2] } : { text: source, url: null }
}

/** A fact's identity: its text without Orca's mark, spacing aside. */
function factKey(text: string): string {
  return oneLine(text)
}

function defusedSeparators(text: string): string {
  const [first = '', ...rest] = text.split('·')
  const parts = [first]
  for (const piece of rest) {
    if (piece.trimStart().slice(0, 5).toLowerCase() === 'from:') {
      parts[parts.length - 1] = parts.at(-1)?.trimEnd() ?? ''
      parts.push(` - ${piece.trimStart()}`)
    } else {
      parts.push(`·${piece}`)
    }
  }
  return parts.join('')
}

/** Where `fact` is now, matched by content, since other writes move line numbers. */
export function findBotMemoryFact(text: string, fact: BotMemoryFact): BotMemoryFact | undefined {
  const facts = parseBotMemoryFacts(text)
  const same = (entry: BotMemoryFact): boolean =>
    entry.text === fact.text && entry.date === fact.date
  return facts.find((entry) => same(entry) && entry.line === fact.line) ?? facts.find(same)
}

/** One fact is one line. */
function oneLine(fact: string): string {
  return fact.replace(/\s+/g, ' ').trim()
}

function factLine(
  prefix: string,
  date: string | null,
  text: string,
  source: string | null = null
): string {
  return `${prefix}${date ? `${date} ` : ''}${text}${source ? `${BOT_MEMORY_SOURCE_SEPARATOR}${source}` : ''}`
}

/** Rewrites one fact, keeping its bullet, date and source; an empty fact removes the line. */
export function editBotMemoryFact(text: string, fact: BotMemoryFact, nextText: string): string {
  const { lines, eol } = splitLines(text)
  const next = oneLine(nextText)
  if (next === '') {
    lines.splice(fact.line, 1)
  } else {
    const prefix = lineFacts(lines)[fact.line]?.prefix ?? '- '
    const line = factLine(prefix, fact.date, next, fact.source)
    // An undashed line edited to look like a heading or rule would stop being a fact: dash it;
    // text that is no fact even dashed ("***") leaves the line as it was.
    const dashed = factLine('- ', fact.date, next, fact.source)
    if (factParts(line)) {
      lines[fact.line] = line
    } else if (factParts(dashed)) {
      lines[fact.line] = dashed
    }
  }
  return lines.join(eol)
}

export function forgetBotMemoryFact(text: string, fact: BotMemoryFact): string {
  return editBotMemoryFact(text, fact, '')
}

/** Newest first: above the first fact, else at the end. */
export function addBotMemoryFact(text: string, fact: string, date: string): string {
  const next = oneLine(fact)
  if (next === '') {
    return text
  }
  const { lines, eol } = splitLines(text)
  const line = factLine('- ', date, next)
  // Above the first list line, so prose a file opens with stays first.
  const facts = lineFacts(lines)
  const first = lines.findIndex((raw, index) => FACT_LINE.test(raw) && facts[index] !== null)
  if (first !== -1) {
    lines.splice(first, 0, line)
    return lines.join(eol)
  }
  const body = text.trimEnd()
  return `${body}${body === '' ? '' : `${eol}${eol}`}${line}${eol}`
}

/** Local calendar date as `YYYY-MM-DD`. */
export function botMemoryDate(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

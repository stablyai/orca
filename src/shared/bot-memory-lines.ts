// MEMORY.md as the owner sees it: one fact per list line, optionally dated, everything else kept byte for byte.
// Orca, not the bot, writes where a fact came from after " · from: "; plain text, so any reader shows it.

import {
  type BotMemoryFact,
  BOT_MEMORY_SOURCE_SEPARATOR,
  FACT_LINE,
  factParts,
  lineFacts,
  parseBotMemoryFacts,
  splitLines
} from './bot-memory-facts'
import { mergeBotMemoryCopies, restoreBotMemoryLines } from './bot-memory-restore'

export { BOT_MEMORY_SEED_INTRO } from './bot-memory-facts'
export { BOT_MEMORY_SOURCE_SEPARATOR, parseBotMemoryFacts, type BotMemoryFact }

/** Lines of MEMORY.md a session loads at start; the rest stays on disk for the bot to read. */
export const BOT_MEMORY_INDEX_LINE_CAP = 200

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

/**
 * Mark new facts in `after` with `label`. Existing facts and observed spacing rewrites keep
 * their old marks. `observed` is the turn's file before lost facts are put back.
 */
export function tagBotMemoryChanges(
  before: string,
  after: string,
  label: string | null,
  observed = after
): string {
  const earlier = new Map<string, number>()
  const known = new Map<string, string | null>()
  const was = splitLines(before).lines
  lineFacts(was).forEach((fact, index) => {
    // Only facts count as already there: a line a fence hid before is new once it is a fact.
    if (!fact) {
      return
    }
    earlier.set(was[index], (earlier.get(was[index]) ?? 0) + 1)
    if (!known.has(fact.text)) {
      known.set(fact.text, fact.source)
    }
  })
  const { lines, eol } = splitLines(after)
  const facts = lineFacts(lines)
  const sourceKey = (text: string): string => text.replace(/\s+/g, ' ')
  const surviving = new Set<string>()
  const fresh = new Map<string, string | undefined>()
  for (const fact of observed === after ? facts : lineFacts(splitLines(observed).lines)) {
    if (!fact) {
      continue
    }
    if (known.has(fact.text)) {
      surviving.add(fact.text)
    } else {
      const key = sourceKey(fact.text)
      fresh.set(key, fresh.has(key) ? undefined : fact.text)
    }
  }
  const respaced = new Map<string, string | null | undefined>()
  for (const [text, source] of known) {
    if (surviving.has(text)) {
      continue
    }
    const replacement = fresh.get(sourceKey(text))
    // Only an unambiguous rewrite seen before put-back can inherit a spacing variant's mark.
    if (replacement !== undefined) {
      respaced.set(replacement, respaced.has(replacement) ? undefined : source)
    }
  }
  return lines
    .map((raw, index) => {
      const seen = earlier.get(raw) ?? 0
      earlier.set(raw, seen - 1)
      const fact = seen > 0 ? null : facts[index]
      // A separator lookalike left in the text would read as a source.
      const text = fact ? defusedSeparators(fact.text) : ''
      if (!fact || !text) {
        return raw
      }
      const exact = known.get(fact.text)
      const kept = exact === undefined ? respaced.get(fact.text) : exact
      const mark = kept === undefined ? label : kept
      // With no source or lookalike to take out, the line stays as written, its mark appended.
      if (text === fact.text && !raw.includes(BOT_MEMORY_SOURCE_SEPARATOR)) {
        return mark ? `${raw.trimEnd()}${BOT_MEMORY_SOURCE_SEPARATOR}${mark}` : raw
      }
      return factLine(fact.prefix, fact.date, text, mark)
    })
    .join(eol)
}

/** `text` without the lines stating `fact`, given as its words or as a whole line. */
export function dropBotMemoryFact(text: string, fact: string): { text: string; dropped: number } {
  const wanted = factParts(`- ${fact.trim().replace(/^[-*]\s+/, '')}`)
  const key = wanted?.text ?? ''
  const { lines, eol } = splitLines(text)
  const facts = lineFacts(lines)
  const kept = lines.filter((_raw, index) => {
    return key === '' || facts[index]?.text !== key
  })
  return { text: kept.join(eol), dropped: lines.length - kept.length }
}

/** A fact line, and the non-blank line it followed (null: the top of the file). */
export type BotMemoryLine = {
  line: string
  after: string | null
  position?: { index: number | null; lineCount: number; eol: '\n' | '\r\n' }
}

/** What a write did to MEMORY.md's facts, by their words: dates and marks aside. */
export type BotMemoryChange = { added: BotMemoryLine[]; removed: BotMemoryLine[] }

export function isEmptyBotMemoryChange(change: BotMemoryChange): boolean {
  return change.added.length === 0 && change.removed.length === 0
}

function rawFactKey(raw: string): string | null {
  return factParts(raw)?.text ?? null
}

/** Each line's fact key in `text`, fences read: null for a line that states no fact. */
function lineKeys(lines: readonly string[]): (string | null)[] {
  return lineFacts(lines).map((fact) => fact?.text ?? null)
}

/** The facts `text` states, by their words. */
export function botMemoryFactKeys(text: string): Set<string> {
  return new Set(lineKeys(splitLines(text).lines).flatMap((key) => key ?? []))
}

export function botMemoryLineKey({ line }: BotMemoryLine): string | null {
  return rawFactKey(line)
}

/** Merge the file and record changes, retaining raw variants for history. */
export function mergeBotMemoryChanges(a: BotMemoryChange, b: BotMemoryChange): BotMemoryChange {
  return {
    added: mergeBotMemoryCopies(a.added, b.added),
    removed: mergeBotMemoryCopies(
      a.removed,
      b.removed,
      a.removed.some(({ position }) => position) || b.removed.some(({ position }) => position)
    )
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
export function botMemoryChange(
  before: string,
  after: string,
  options?: { keepRemovedPositions?: boolean }
): BotMemoryChange {
  const only = (from: string, other: string, keepPositions = false): BotMemoryLine[] => {
    const keys = new Set(lineKeys(splitLines(other).lines))
    const lines: BotMemoryLine[] = []
    let previous: string | null = null
    const { lines: rows, eol } = splitLines(from)
    const rowKeys = lineKeys(rows)
    for (const [index, raw] of rows.entries()) {
      const key = rowKeys[index]
      if (key !== null && !keys.has(key)) {
        lines.push({
          line: raw,
          after: previous,
          ...(keepPositions ? { position: { index, lineCount: rows.length, eol } } : {})
        })
      }
      previous = raw.trim() === '' ? previous : raw
    }
    return lines
  }
  return { added: only(after, before), removed: only(before, after, options?.keepRemovedPositions) }
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
  if (change.added.length === 0) {
    return kept.join(eol)
  }
  const indexed = change.added.filter(({ position }) => position?.index != null)
  const original = (indexed[0] ?? change.added.find(({ position }) => position))?.position
  const outputEol = original && lines.length === 1 ? original.eol : eol
  if (
    text === '' &&
    original?.index === 0 &&
    indexed.length === original.lineCount &&
    indexed.at(-1)?.position?.index === original.lineCount - 1
  ) {
    kept.length = 0
  }
  const present = new Set(lineKeys(kept))
  const copies = change.added.filter(({ line, position }) => {
    const key = rawFactKey(line)
    if (key === null || present.has(key)) {
      return false
    }
    // Every removed copy goes back; an unpositioned line is one fact, put back once.
    if (!position) {
      present.add(key)
    }
    return true
  })
  return restoreBotMemoryLines(kept, copies).join(outputEol)
}

/** A source's words and its link, as Orca writes them: "Slack, Dana <https://…>". */
export function botMemorySourceLink(source: string): { text: string; url: string | null } {
  const linked = /^(.*?)\s*<(https:\/\/[^\s<>]+)>$/.exec(source)
  return linked ? { text: linked[1], url: linked[2] } : { text: source, url: null }
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

/** One fact is one line: its line breaks become spaces, and every other space stays. */
function oneLine(fact: string): string {
  return fact.replace(/[ \t]*[\n\r\u2028\u2029]+[ \t]*/g, ' ').trim()
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

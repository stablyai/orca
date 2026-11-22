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

export const FACT_LINE = /^(\s*[-*]\s+)(.*)$/
/** The how-to line a new bot's MEMORY.md starts with (bot-home.ts), not a fact. */
export const BOT_MEMORY_SEED_INTRO =
  'One line per fact, newest first. Longer notes go in memory/<topic>.md.'
// Headings ("# x", never "#123"), table rows, HTML comments and rules (---, ***, ===, * * *).
const NOT_A_FACT = /^(?:#{1,6}(?:\s|$)|\||<!--|[\s*_=:-]+$)/
const FENCE = /^\s*(`{3,}|~{3,})/
const DATED_TEXT = /^(\d{4}-\d{2}-\d{2})(?:\s*[:\u2013\u2014-]\s*|\s+)(.*)$/

export function splitLines(text: string): { lines: string[]; eol: '\n' | '\r\n' } {
  return { lines: text.split(/\r?\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' }
}

type FactParts = Omit<BotMemoryFact, 'line'> & { prefix: string }

/** Each line's fact, or null: a line in a code fence is never one, whatever it looks like. */
export function lineFacts(lines: readonly string[]): (FactParts | null)[] {
  // The open fence, if any: it closes only on the same character at least as many times.
  let open: string | null = null
  return lines.map((raw) => {
    const fence = FENCE.exec(raw)?.[1]
    // A closer is the same character, at least as long, with nothing but spaces after it.
    const closes =
      open !== null &&
      fence !== undefined &&
      fence[0] === open[0] &&
      fence.length >= open.length &&
      raw.trim() === fence
    if (fence && (open === null || closes)) {
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

export function factParts(raw: string): FactParts | null {
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

// Why the strings module only: it carries Monaco's character tables without evaluating NLS.
import {
  AmbiguousCharacters,
  InvisibleCharacters
} from 'monaco-editor/esm/vs/base/common/strings.js'
import { getIntlLocale } from '@/i18n/i18n'
import { pierreRowTextRange } from './pierre-diff-search-view'

export type UnicodeHighlightKind = 'invisible' | 'ambiguous'
export type UnicodeHighlight = { start: number; end: number; kind: UnicodeHighlightKind }

export const PIERRE_UNICODE_HIGHLIGHT_CSS = `
::highlight(orca-diff-unicode-ambiguous) { background-color: color-mix(in srgb, var(--status-warning) 35%, transparent); }
::highlight(orca-diff-unicode-invisible) { background-color: color-mix(in srgb, var(--status-warning) 35%, transparent); text-decoration: underline wavy var(--status-warning); }
`

const WORD = /[\p{L}\p{M}\p{N}_]/u
const BASIC_ASCII = /^[\t\n\r\x20-\x7E]$/

type Matcher = { pattern: RegExp; ambiguous: AmbiguousCharacters | null }
const matchers = new Map<string, Matcher>()

/** Monaco's allowed locales: characters native to the UI or OS language are not "ambiguous". */
function allowedLocales(): string[] {
  const known = new Set(AmbiguousCharacters.getLocales())
  const locales = new Set<string>()
  for (const tag of [getIntlLocale(), ...navigator.languages]) {
    const lower = tag.toLowerCase()
    const primary = lower.split('-')[0]
    const candidates = [tag, lower, primary]
    if (primary === 'zh') {
      candidates.push(/hant|tw|hk|mo/.test(lower) ? 'zh-hant' : 'zh-hans')
    }
    if (primary === 'pt') {
      candidates.push('pt-BR')
    }
    for (const candidate of candidates) {
      if (known.has(candidate)) {
        locales.add(candidate)
      }
    }
  }
  return [...locales]
}

function getMatcher(includeAmbiguous: boolean): Matcher {
  const locales = includeAmbiguous ? allowedLocales() : []
  const key = `${includeAmbiguous}:${locales.join(',')}`
  let matcher = matchers.get(key)
  if (!matcher) {
    const ambiguous = includeAmbiguous ? AmbiguousCharacters.getInstance(new Set(locales)) : null
    const codePoints = new Set<number>(InvisibleCharacters.codePoints)
    // Monaco never sees \r (models normalize EOL); Pierre lines may keep it.
    for (const codePoint of [0x20, 0x09, 0x0a, 0x0d]) {
      codePoints.delete(codePoint)
    }
    for (const codePoint of ambiguous?.getConfusableCodePoints() ?? new Set<number>()) {
      codePoints.add(codePoint)
    }
    const characters = [...codePoints].map((codePoint) => `\\u{${codePoint.toString(16)}}`).join('')
    matcher = { pattern: new RegExp(`[${characters}]`, 'gu'), ambiguous }
    matchers.set(key, matcher)
  }
  return matcher
}

function wordAround(line: string, start: number, end: number): string {
  let from = start
  let to = end
  while (from > 0 && WORD.test(line[from - 1])) {
    from--
  }
  while (to < line.length && WORD.test(line[to])) {
    to++
  }
  return line.slice(from, to)
}

/**
 * The characters Monaco's unicode highlighter flags in one line: invisible ones always, and
 * ones confusable with ASCII unless the surrounding word is clearly in another script.
 */
export function findUnicodeHighlights(line: string, includeAmbiguous: boolean): UnicodeHighlight[] {
  const { pattern, ambiguous } = getMatcher(includeAmbiguous)
  pattern.lastIndex = 0
  const highlights: UnicodeHighlight[] = []
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const start = match.index
    const end = start + match[0].length
    const codePoint = match[0].codePointAt(0)!
    const invisible = InvisibleCharacters.isInvisibleCharacter(codePoint)
    const word = wordAround(line, start, end)
    let hasAscii = false
    let hasForeignLetter = false
    for (const char of word) {
      const point = char.codePointAt(0)!
      if (BASIC_ASCII.test(char)) {
        hasAscii = true
      } else if (
        !ambiguous?.isAmbiguous(point) &&
        !InvisibleCharacters.isInvisibleCharacter(point)
      ) {
        hasForeignLetter = true
      }
    }
    // Same rule as Monaco: a word written in another script is not a spoofing attempt.
    if (!hasAscii && hasForeignLetter) {
      continue
    }
    if (invisible) {
      highlights.push({ start, end, kind: 'invisible' })
    } else if (ambiguous?.isAmbiguous(codePoint)) {
      highlights.push({ start, end, kind: 'ambiguous' })
    }
  }
  return highlights
}

const painted = new Map<symbol, Record<UnicodeHighlightKind, Range[]>>()

function paint(owner: symbol, ranges?: Record<UnicodeHighlightKind, Range[]>): void {
  if (ranges) {
    painted.set(owner, ranges)
  } else if (!painted.delete(owner)) {
    return
  }
  if (typeof Highlight === 'undefined' || !CSS.highlights) {
    return
  }
  for (const kind of ['invisible', 'ambiguous'] as const) {
    const highlight = new Highlight()
    for (const entry of painted.values()) {
      for (const range of entry[kind]) {
        highlight.add(range)
      }
    }
    const name = `orca-diff-unicode-${kind}`
    if (highlight.size) {
      CSS.highlights.set(name, highlight)
    } else {
      CSS.highlights.delete(name)
    }
  }
}

/** Repaints the flagged characters of every row Pierre currently has mounted. */
export function paintPierreUnicodeHighlights(
  owner: symbol,
  host: HTMLElement | null,
  includeAmbiguous: boolean
): void {
  const rows = host?.shadowRoot?.querySelectorAll<HTMLElement>('[data-code] [data-line]')
  if (!rows) {
    paint(owner)
    return
  }
  const ranges: Record<UnicodeHighlightKind, Range[]> = { invisible: [], ambiguous: [] }
  for (const row of rows) {
    const text = row.textContent ?? ''
    for (const { start, end, kind } of findUnicodeHighlights(text, includeAmbiguous)) {
      // A zero-width character has no box to paint, so mark the character it sits before.
      const next = text.codePointAt(end)
      const visibleEnd =
        kind === 'invisible' && next !== undefined ? end + (next > 0xffff ? 2 : 1) : end
      const range = pierreRowTextRange(row, start, visibleEnd)
      if (range) {
        ranges[kind].push(range)
      }
    }
  }
  paint(owner, ranges)
}

export function clearPierreUnicodeHighlights(owner: symbol): void {
  paint(owner)
}

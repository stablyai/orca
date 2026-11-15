// Why these: after them a `/` starts a regex literal, not a division.
const REGEX_PRECEDERS = new Set('(,=:[!&|?{};+-*%<>~^')

function skipRegexLiteral(text: string, start: number): number {
  let inClass = false
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
    } else if (ch === '\n') {
      return i
    } else if (ch === '[') {
      inClass = true
    } else if (ch === ']') {
      inClass = false
    } else if (ch === '/' && !inClass) {
      return i + 1
    }
  }
  return text.length
}

function skipString(text: string, start: number): number {
  const quote = text[start]
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') {
      i++
    } else if (ch === quote) {
      return i + 1
    } else if (ch === '\n' && quote !== '`') {
      // Why: a quote/apostrophe in HTML prose must not swallow the rest of the file.
      return i
    }
  }
  return text.length
}

/**
 * Blanks `//` and `/* *\/` comments (and `<!-- -->` in HTML) so commented-out calls do not count,
 * while keeping strings and regex literals, so a URL's `//` does not end the line.
 */
export function stripScriptComments(text: string, html: boolean): string {
  const source = html ? text.replace(/<!--[\s\S]*?-->/g, ' ') : text
  const kept: string[] = []
  let from = 0
  let last = ''
  let i = 0
  while (i < source.length) {
    const ch = source[i]!
    const next = source[i + 1]
    if (ch === '/' && (next === '/' || next === '*')) {
      kept.push(source.slice(from, i), ' ')
      const end = next === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2)
      i = end === -1 ? source.length : next === '/' ? end : end + 2
      from = i
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      i = skipString(source, i)
      last = ch
      continue
    }
    if (ch === '/' && (last === '' || REGEX_PRECEDERS.has(last))) {
      i = skipRegexLiteral(source, i)
      last = '/'
      continue
    }
    if (ch !== ' ' && ch !== '\n' && ch !== '\t' && ch !== '\r') {
      last = ch
    }
    i++
  }
  kept.push(source.slice(from))
  return kept.join('')
}

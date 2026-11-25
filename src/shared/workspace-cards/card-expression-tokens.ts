export type CardExpressionToken =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'op'; value: string }

// Longest first, so `<=` wins over `<`.
const OPERATORS = [
  '&&',
  '||',
  '??',
  '==',
  '!=',
  '<=',
  '>=',
  '!',
  '<',
  '>',
  '+',
  '-',
  '?',
  ':',
  '(',
  ')',
  ','
]

export class CardExpressionError extends Error {
  constructor(message: string, source: string) {
    super(`${message} in \`${source}\``)
    this.name = 'CardExpressionError'
  }
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isNameStart(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isNamePart(ch: string): boolean {
  return isNameStart(ch) || isDigit(ch) || ch === '.'
}

export function tokenizeCardExpression(source: string): CardExpressionToken[] {
  const tokens: CardExpressionToken[] = []
  let i = 0
  while (i < source.length) {
    const ch = source.charAt(i)
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++
      continue
    }
    if (isDigit(ch)) {
      let end = i
      while (end < source.length && (isDigit(source.charAt(end)) || source.charAt(end) === '.')) {
        end++
      }
      const value = Number(source.slice(i, end))
      if (!Number.isFinite(value)) {
        throw new CardExpressionError(`Invalid number ${source.slice(i, end)}`, source)
      }
      tokens.push({ kind: 'number', value })
      i = end
      continue
    }
    if (ch === "'" || ch === '"') {
      const end = source.indexOf(ch, i + 1)
      if (end === -1) {
        throw new CardExpressionError('Unterminated string', source)
      }
      tokens.push({ kind: 'string', value: source.slice(i + 1, end) })
      i = end + 1
      continue
    }
    if (isNameStart(ch)) {
      let end = i
      while (end < source.length && isNamePart(source.charAt(end))) {
        end++
      }
      const name = source.slice(i, end)
      if (name.endsWith('.') || name.includes('..')) {
        throw new CardExpressionError(`Invalid path ${name}`, source)
      }
      tokens.push({ kind: 'name', value: name })
      i = end
      continue
    }
    const op = OPERATORS.find((candidate) => source.startsWith(candidate, i))
    if (!op) {
      throw new CardExpressionError(`Unexpected '${ch}'`, source)
    }
    tokens.push({ kind: 'op', value: op })
    i += op.length
  }
  return tokens
}

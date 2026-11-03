import {
  CardExpressionError,
  tokenizeCardExpression,
  type CardExpressionToken
} from './card-expression-tokens'

export { CardExpressionError } from './card-expression-tokens'

/** Read-only facts an expression evaluates over; only own properties are ever read. */
export type CardExpressionScope = Readonly<Record<string, unknown>>
export type CardExpressionValue = (scope: CardExpressionScope) => unknown

export type CompiledCardExpression = {
  evaluate: CardExpressionValue
  /** First path segment of every fact the expression reads, e.g. `ws` for `ws.branch`. */
  roots: ReadonlySet<string>
}

export const CARD_EXPRESSION_LIMITS = { maxLength: 2048, maxDepth: 32 } as const

const FUNCTIONS: Readonly<Record<string, (...args: unknown[]) => unknown>> = {
  len: (value) => (typeof value === 'string' || Array.isArray(value) ? value.length : 0),
  trim: (value) => (typeof value === 'string' ? value.trim() : ''),
  lower: (value) => (typeof value === 'string' ? value.toLowerCase() : ''),
  upper: (value) => (typeof value === 'string' ? value.toUpperCase() : ''),
  contains: (container, value) =>
    typeof container === 'string'
      ? typeof value === 'string' && container.includes(value)
      : Array.isArray(container) && container.includes(value)
}

const BINARY_PRECEDENCE: Readonly<Record<string, number>> = {
  '??': 1,
  '||': 2,
  '&&': 3,
  '==': 4,
  '!=': 4,
  '<': 5,
  '<=': 5,
  '>': 5,
  '>=': 5,
  '+': 6,
  '-': 6
}

const LITERALS: Readonly<Record<string, unknown>> = { true: true, false: false, null: null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Why own properties only: a template must never reach prototypes, constructors or methods. */
export function readCardFactPath(scope: CardExpressionScope, segments: readonly string[]): unknown {
  let value: unknown = scope
  for (const segment of segments) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) {
      return null
    }
    value = value[segment]
  }
  return value ?? null
}

function toText(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
    ? String(value)
    : ''
}

function add(a: unknown, b: unknown): unknown {
  if (typeof a === 'number' && typeof b === 'number') {
    return a + b
  }
  return toText(a) + toText(b)
}

function binary(op: string, l: CardExpressionValue, r: CardExpressionValue): CardExpressionValue {
  switch (op) {
    case '&&':
      return (s) => l(s) && r(s)
    case '||':
      return (s) => l(s) || r(s)
    case '??':
      return (s) => l(s) ?? r(s)
    case '==':
      return (s) => l(s) === r(s)
    case '!=':
      return (s) => l(s) !== r(s)
    case '<':
      return (s) => Number(l(s)) < Number(r(s))
    case '<=':
      return (s) => Number(l(s)) <= Number(r(s))
    case '>':
      return (s) => Number(l(s)) > Number(r(s))
    case '>=':
      return (s) => Number(l(s)) >= Number(r(s))
    case '+':
      return (s) => add(l(s), r(s))
    default:
      return (s) => Number(l(s)) - Number(r(s))
  }
}

class Parser {
  private pos = 0
  private depth = 0
  readonly roots = new Set<string>()

  constructor(
    private readonly tokens: CardExpressionToken[],
    private readonly source: string
  ) {}

  parse(): CardExpressionValue {
    if (this.tokens.length === 0) {
      throw new CardExpressionError('Empty expression', this.source)
    }
    const value = this.ternary()
    if (this.pos !== this.tokens.length) {
      throw new CardExpressionError('Unexpected trailing input', this.source)
    }
    return value
  }

  private peekOp(value: string): boolean {
    const token = this.tokens[this.pos]
    return token?.kind === 'op' && token.value === value
  }

  private expectOp(value: string): void {
    if (!this.peekOp(value)) {
      throw new CardExpressionError(`Expected '${value}'`, this.source)
    }
    this.pos++
  }

  private ternary(): CardExpressionValue {
    const condition = this.binary(1)
    if (!this.peekOp('?')) {
      return condition
    }
    this.pos++
    const whenTrue = this.ternary()
    this.expectOp(':')
    const whenFalse = this.ternary()
    return (s) => (condition(s) ? whenTrue(s) : whenFalse(s))
  }

  private binary(minPrecedence: number): CardExpressionValue {
    let left = this.unary()
    for (;;) {
      const token = this.tokens[this.pos]
      const precedence = token?.kind === 'op' ? BINARY_PRECEDENCE[token.value] : undefined
      if (token === undefined || precedence === undefined || precedence < minPrecedence) {
        return left
      }
      this.pos++
      left = binary(token.value, left, this.binary(precedence + 1))
    }
  }

  private unary(): CardExpressionValue {
    if (++this.depth > CARD_EXPRESSION_LIMITS.maxDepth) {
      throw new CardExpressionError('Expression nested too deeply', this.source)
    }
    try {
      if (this.peekOp('!')) {
        this.pos++
        const operand = this.unary()
        return (s) => !operand(s)
      }
      if (this.peekOp('-')) {
        this.pos++
        const operand = this.unary()
        return (s) => -Number(operand(s))
      }
      return this.primary()
    } finally {
      this.depth--
    }
  }

  private primary(): CardExpressionValue {
    const token = this.tokens[this.pos++]
    if (token === undefined) {
      throw new CardExpressionError('Unexpected end', this.source)
    }
    if (token.kind === 'number' || token.kind === 'string') {
      const value = token.value
      return () => value
    }
    if (token.kind === 'op') {
      if (token.value !== '(') {
        throw new CardExpressionError(`Unexpected '${token.value}'`, this.source)
      }
      const inner = this.ternary()
      this.expectOp(')')
      return inner
    }
    if (Object.hasOwn(LITERALS, token.value)) {
      const value = LITERALS[token.value]
      return () => value
    }
    if (this.peekOp('(')) {
      return this.call(token.value)
    }
    const segments = token.value.split('.')
    this.roots.add(segments[0] ?? token.value)
    return (s) => readCardFactPath(s, segments)
  }

  private call(name: string): CardExpressionValue {
    const fn = Object.hasOwn(FUNCTIONS, name) ? FUNCTIONS[name] : undefined
    if (!fn) {
      throw new CardExpressionError(`Unknown function ${name}`, this.source)
    }
    this.pos++
    const args: CardExpressionValue[] = []
    while (!this.peekOp(')')) {
      args.push(this.ternary())
      if (!this.peekOp(')')) {
        this.expectOp(',')
      }
    }
    this.pos++
    return (s) => fn(...args.map((arg) => arg(s)))
  }
}

/** Compiles once; evaluation is pure, allocation-light and never throws on missing facts. */
export function compileCardExpression(source: string): CompiledCardExpression {
  if (source.length > CARD_EXPRESSION_LIMITS.maxLength) {
    throw new CardExpressionError('Expression too long', source.slice(0, 40))
  }
  const parser = new Parser(tokenizeCardExpression(source), source)
  const evaluate = parser.parse()
  return { evaluate, roots: parser.roots }
}

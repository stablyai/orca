export type JsonTextStructureLimits = Readonly<{
  structuralTokens: number
  nestingDepth: number
}>

export class JsonTextStructureCapacityError extends Error {
  constructor(
    readonly resource: keyof JsonTextStructureLimits,
    readonly limit: number
  ) {
    super(
      resource === 'structuralTokens'
        ? `JSON structure exceeds ${limit} tokens`
        : `JSON nesting exceeds ${limit} levels`
    )
    this.name = 'JsonTextStructureCapacityError'
  }
}

export type JsonTextStructureUsage = Readonly<{
  structuralTokens: number
  nestingDepth: number
}>

export class JsonTextStructureValidator {
  private structuralTokens = 0
  private depth = 0
  private maximumDepth = 0
  private inString = false
  private escaped = false

  constructor(private readonly limits: JsonTextStructureLimits) {
    assertLimit(limits.structuralTokens)
    assertLimit(limits.nestingDepth)
  }

  consume(content: string, start = 0, end = content.length): void {
    assertTextRange(content, start, end)
    for (let index = start; index < end; index += 1) {
      const code = content.charCodeAt(index)
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false
        } else if (code === BACKSLASH) {
          this.escaped = true
        } else if (code === QUOTE) {
          this.inString = false
        }
        continue
      }
      if (code === QUOTE) {
        this.inString = true
        continue
      }
      if (!isStructuralToken(code)) {
        continue
      }
      this.structuralTokens += 1
      if (this.structuralTokens > this.limits.structuralTokens) {
        throw new JsonTextStructureCapacityError('structuralTokens', this.limits.structuralTokens)
      }
      if (code === OPEN_BRACE || code === OPEN_BRACKET) {
        this.depth += 1
        this.maximumDepth = Math.max(this.maximumDepth, this.depth)
        if (this.depth > this.limits.nestingDepth) {
          throw new JsonTextStructureCapacityError('nestingDepth', this.limits.nestingDepth)
        }
      } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
        this.depth = Math.max(0, this.depth - 1)
      }
    }
  }

  usage(): JsonTextStructureUsage {
    return {
      structuralTokens: this.structuralTokens,
      nestingDepth: this.maximumDepth
    }
  }
}

export function assertJsonTextStructureWithinLimits(
  content: string,
  limits: JsonTextStructureLimits
): void {
  new JsonTextStructureValidator(limits).consume(content)
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('JSON structure limits must be non-negative safe integers')
  }
}

function assertTextRange(content: string, start: number, end: number): void {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end > content.length
  ) {
    throw new RangeError('JSON text range is out of bounds')
  }
}

const QUOTE = 0x22
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_BRACKET = 0x5b
const BACKSLASH = 0x5c
const CLOSE_BRACKET = 0x5d
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d

function isStructuralToken(code: number): boolean {
  return (
    code === OPEN_BRACE ||
    code === CLOSE_BRACE ||
    code === OPEN_BRACKET ||
    code === CLOSE_BRACKET ||
    code === COMMA ||
    code === COLON
  )
}

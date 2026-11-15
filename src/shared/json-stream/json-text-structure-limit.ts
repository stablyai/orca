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

export function assertJsonTextStructureWithinLimits(
  content: string,
  limits: JsonTextStructureLimits
): void {
  new JsonTextStructureValidator(limits).consume(content)
}

/** Carries string/escape and structure state across bounded chunks. */
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

  consume(content: string): void {
    let linearString = false
    for (let index = 0; index < content.length; index += 1) {
      const character = content[index]
      if (this.inString) {
        if (this.escaped) {
          this.escaped = false
          continue
        }
        if (!linearString) {
          const quote = content.indexOf('"', index)
          const end = quote === -1 ? content.length : quote
          let backslashes = 0
          for (let at = end - 1; at >= index && content[at] === '\\'; at -= 1) {
            backslashes++
          }
          if (quote === -1) {
            this.escaped = backslashes % 2 !== 0
            return
          }
          index = quote
          if (backslashes % 2 === 0) {
            this.inString = false
          } else {
            // Escape-heavy strings scan linearly instead of repeating native searches.
            linearString = true
          }
          continue
        }
        if (character === '\\') {
          this.escaped = true
        } else if (character === '"') {
          this.inString = false
          linearString = false
        }
        continue
      }
      if (character === '"') {
        this.inString = true
        continue
      }
      if (!isStructuralToken(character)) {
        continue
      }
      this.structuralTokens++
      if (this.structuralTokens > this.limits.structuralTokens) {
        throw new JsonTextStructureCapacityError('structuralTokens', this.limits.structuralTokens)
      }
      if (character === '{' || character === '[') {
        this.depth++
        this.maximumDepth = Math.max(this.maximumDepth, this.depth)
        if (this.depth > this.limits.nestingDepth) {
          throw new JsonTextStructureCapacityError('nestingDepth', this.limits.nestingDepth)
        }
      } else if (character === '}' || character === ']') {
        this.depth = Math.max(0, this.depth - 1)
      }
    }
  }

  usage(): { structuralTokens: number; nestingDepth: number } {
    return { structuralTokens: this.structuralTokens, nestingDepth: this.maximumDepth }
  }
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('JSON structure limits must be non-negative safe integers')
  }
}

function isStructuralToken(character: string | undefined): boolean {
  return (
    character === '{' ||
    character === '}' ||
    character === '[' ||
    character === ']' ||
    character === ',' ||
    character === ':'
  )
}

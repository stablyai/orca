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
  assertLimit(limits.structuralTokens)
  assertLimit(limits.nestingDepth)
  let structuralTokens = 0
  let depth = 0
  for (let index = 0; index < content.length; index += 1) {
    const character = content[index]
    if (character === '"') {
      let quote = content.indexOf('"', index + 1)
      if (quote !== -1) {
        // Only an odd backslash run escapes the quote.
        let backslashes = 0
        for (let at = quote - 1; at > index && content[at] === '\\'; at -= 1) {
          backslashes += 1
        }
        if (backslashes % 2 !== 0) {
          // Escape-heavy strings use the linear scan to avoid repeated native searches.
          let escaped = false
          for (quote += 1; quote < content.length; quote += 1) {
            if (escaped) {
              escaped = false
            } else if (content[quote] === '\\') {
              escaped = true
            } else if (content[quote] === '"') {
              break
            }
          }
          if (quote === content.length) {
            quote = -1
          }
        }
      }
      if (quote === -1) {
        return
      }
      index = quote
      continue
    }
    if (!isStructuralToken(character)) {
      continue
    }
    structuralTokens += 1
    if (structuralTokens > limits.structuralTokens) {
      throw new JsonTextStructureCapacityError('structuralTokens', limits.structuralTokens)
    }
    if (character === '{' || character === '[') {
      depth += 1
      if (depth > limits.nestingDepth) {
        throw new JsonTextStructureCapacityError('nestingDepth', limits.nestingDepth)
      }
    } else if (character === '}' || character === ']') {
      depth = Math.max(0, depth - 1)
    }
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

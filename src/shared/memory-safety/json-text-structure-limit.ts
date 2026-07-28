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

const QUOTE = 0x22
const COMMA = 0x2c
const COLON = 0x3a
const OPEN_BRACKET = 0x5b
const CLOSE_BRACKET = 0x5d
const OPEN_BRACE = 0x7b
const CLOSE_BRACE = 0x7d

export function assertJsonTextStructureWithinLimits(
  content: string,
  limits: JsonTextStructureLimits
): void {
  assertLimit(limits.structuralTokens)
  assertLimit(limits.nestingDepth)
  let structuralTokens = 0
  let depth = 0
  // Why: this runs on the daemon's hot receive path, so the scan reads char codes and skips
  // string bodies wholesale. A monotonic escape cursor keeps the lookups O(n) overall.
  let nextEscape = content.indexOf('\\')

  for (let index = 0; index < content.length; index += 1) {
    const code = content.charCodeAt(index)

    if (code === QUOTE) {
      // String contents carry no structure; jump to the closing quote rather than
      // stepping through every byte of a large payload.
      let cursor = index + 1
      // Why: hoisted so an escape-dense body rescans the tail once per *skipped* quote rather
      // than once per escape — the latter is quadratic on a payload carrying escaped text.
      let closing = content.indexOf('"', cursor)
      for (;;) {
        if (closing < 0) {
          return
        }
        if (nextEscape >= 0 && nextEscape < cursor) {
          nextEscape = content.indexOf('\\', cursor)
        }
        if (nextEscape < 0 || nextEscape > closing) {
          index = closing
          break
        }
        cursor = nextEscape + 2
        if (cursor > closing) {
          closing = content.indexOf('"', cursor)
        }
      }
      continue
    }

    if (
      code !== OPEN_BRACE &&
      code !== CLOSE_BRACE &&
      code !== OPEN_BRACKET &&
      code !== CLOSE_BRACKET &&
      code !== COMMA &&
      code !== COLON
    ) {
      continue
    }

    structuralTokens += 1
    if (structuralTokens > limits.structuralTokens) {
      throw new JsonTextStructureCapacityError('structuralTokens', limits.structuralTokens)
    }
    if (code === OPEN_BRACE || code === OPEN_BRACKET) {
      depth += 1
      if (depth > limits.nestingDepth) {
        throw new JsonTextStructureCapacityError('nestingDepth', limits.nestingDepth)
      }
    } else if (code === CLOSE_BRACE || code === CLOSE_BRACKET) {
      depth = Math.max(0, depth - 1)
    }
  }
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('JSON structure limits must be non-negative safe integers')
  }
}

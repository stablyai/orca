import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError,
  type JsonTextStructureLimits
} from './json-text-structure-limit'
import { createJsonTokenReader } from './json-token-reader'

export type RipgrepMatchMessage = {
  type?: string
  data?: {
    path?: { text?: string }
    lines?: { text?: string; bytes?: string }
    line_number?: number
    submatches?: { start: number; end: number }[]
  }
}

export function parseRipgrepMatchJson(
  line: string,
  maxMatches: number,
  limits: JsonTextStructureLimits
): RipgrepMatchMessage {
  try {
    assertJsonTextStructureWithinLimits(line, limits)
    return JSON.parse(line)
  } catch (error) {
    if (
      !(error instanceof JsonTextStructureCapacityError) ||
      error.resource !== 'structuralTokens'
    ) {
      throw error
    }
    return parseDenseRipgrepMatchJson(line, maxMatches, limits.nestingDepth)
  }
}

type RipgrepJsonFrame = {
  kind: 'object' | 'array'
  context: 'root' | 'data' | 'path' | 'lines' | 'matches' | 'match' | null
  key?: string
  values: number
  keys?: Set<string>
  start?: number
  end?: number
}

/** Dense rg records retain only the requested ranges while validating the entire record. */
export function parseDenseRipgrepMatchJson(
  line: string,
  maxMatches: number,
  nestingDepth: number
): RipgrepMatchMessage {
  const data: NonNullable<RipgrepMatchMessage['data']> = { submatches: [] }
  const result: RipgrepMatchMessage = { data }
  const frames: RipgrepJsonFrame[] = []
  let elementTokens = 0
  const countTokens = (amount = 1): void => {
    if (frames.length >= 4 && (elementTokens += amount) > 32 * 1024) {
      throw new Error('rg submatch structure exceeds limit')
    }
  }
  const parser = createJsonTokenReader((token) => {
    const current = frames.at(-1)
    if (token.name === 'keyValue') {
      if (!current || current.kind !== 'object') {
        throw new SyntaxError('Unexpected rg object key')
      }
      if (current.values++ > 0) {
        countTokens()
      }
      // Packed tokens omit commas and colons; include them in the existing structure budget.
      countTokens(2)
      current.key = token.value
      if (current.keys?.has(token.value)) {
        throw new SyntaxError('Duplicate rg object key')
      }
      current.keys?.add(token.value)
      if ((current.keys?.size ?? 0) > 128) {
        throw new Error('Too many rg record fields')
      }
      return
    }
    if (token.name === 'endObject' || token.name === 'endArray') {
      const frame = frames.pop()
      countTokens()
      if (frame?.context === 'match') {
        if (typeof frame.start !== 'number' || typeof frame.end !== 'number') {
          throw new SyntaxError('Invalid rg submatch')
        }
        if (data.submatches && data.submatches.length < maxMatches) {
          data.submatches.push({ start: frame.start, end: frame.end })
        }
      }
      return
    }
    if (current?.kind === 'array' && current.values++ > 0) {
      countTokens()
    }
    if (current?.context === 'match' && (current.key === 'start' || current.key === 'end')) {
      current[current.key] = undefined
    }
    if (token.name === 'startObject' || token.name === 'startArray') {
      const kind = token.name === 'startObject' ? 'object' : 'array'
      let context: RipgrepJsonFrame['context'] = null
      if (!current && kind === 'object') {
        context = 'root'
      } else if (current?.context === 'root' && current.key === 'data' && kind === 'object') {
        context = 'data'
      } else if (current?.context === 'data') {
        if ((current.key === 'lines' || current.key === 'path') && kind === 'object') {
          context = current.key
        }
        if (current.key === 'submatches' && kind === 'array') {
          context = 'matches'
        }
      } else if (current?.context === 'matches') {
        if (kind !== 'object') {
          throw new SyntaxError('Invalid rg submatch')
        }
        context = 'match'
      }
      frames.push({
        kind,
        context,
        values: 0,
        keys: kind === 'object' && frames.length < 2 ? new Set() : undefined
      })
      if (frames.length > nestingDepth) {
        throw new Error('rg record nesting exceeds limit')
      }
      if (frames.length === 4) {
        elementTokens = 0
      }
      countTokens()
      return
    }
    countTokens()
    if (current?.context === 'matches') {
      throw new SyntaxError('Invalid rg submatch')
    }
    if (token.name === 'numberValue') {
      const value = Number(token.value)
      if (current?.context === 'match' && (current.key === 'start' || current.key === 'end')) {
        current[current.key] = value
      }
      if (current?.context === 'data' && current.key === 'line_number') {
        data.line_number = value
      }
    } else if (token.name === 'stringValue') {
      if (current?.context === 'root' && current.key === 'type') {
        result.type = token.value
      }
      if (current?.context === 'path' && current.key === 'text') {
        data.path = { text: token.value }
      }
      if (current?.context === 'lines' && (current.key === 'text' || current.key === 'bytes')) {
        data.lines ??= {}
        data.lines[current.key] = token.value
      }
    }
  }, 8 * 1024)
  parser.write(line)
  parser.end()
  return result
}

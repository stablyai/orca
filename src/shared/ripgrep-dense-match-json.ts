import {
  assertJsonTextStructureWithinLimits,
  JsonTextStructureCapacityError,
  type JsonTextStructureLimits
} from './json-text-structure-limit'
import { JSONParser, TokenType } from '@streamparser/json'

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

/** Dense rg records retain only the requested ranges while validating the entire record. */
export function parseDenseRipgrepMatchJson(
  line: string,
  maxMatches: number,
  nestingDepth: number
): RipgrepMatchMessage {
  const parser = new JSONParser({
    paths: [
      '$.type',
      '$.data.path.text',
      '$.data.lines.text',
      '$.data.lines.bytes',
      '$.data.line_number',
      '$.data.submatches.*'
    ],
    keepStack: false,
    stringBufferSize: 64 * 1024
  })
  const data: NonNullable<RipgrepMatchMessage['data']> = { submatches: [] }
  const result: RipgrepMatchMessage = { data }
  const containers: { object: boolean; expectingKey: boolean; keys?: Set<string> }[] = []
  let elementTokens = 0
  parser.onToken = ({ token, value }) => {
    const current = containers.at(-1)
    if (current?.object && current.expectingKey && token === TokenType.STRING) {
      if (typeof value !== 'string') {
        throw new SyntaxError('Invalid rg object key')
      }
      if (current.keys?.has(value)) {
        throw new SyntaxError('Duplicate rg object key')
      }
      current.keys?.add(value)
      if ((current.keys?.size ?? 0) > 128) {
        throw new Error('Too many rg record fields')
      }
      current.expectingKey = false
    }
    if (token === TokenType.LEFT_BRACE || token === TokenType.LEFT_BRACKET) {
      containers.push({
        object: token === TokenType.LEFT_BRACE,
        expectingKey: token === TokenType.LEFT_BRACE,
        // rg's envelope keys are unique; reject duplicates instead of mixing projections.
        keys: containers.length < 2 ? new Set() : undefined
      })
      if (containers.length > nestingDepth) {
        throw new Error('rg record nesting exceeds limit')
      }
      if (containers.length === 4) {
        elementTokens = 0
      }
    } else if (token === TokenType.RIGHT_BRACE || token === TokenType.RIGHT_BRACKET) {
      containers.pop()
    } else if (token === TokenType.COMMA && current?.object) {
      current.expectingKey = true
    }
    if (containers.length >= 4 && ++elementTokens > 32 * 1024) {
      throw new Error('rg submatch structure exceeds limit')
    }
  }
  parser.onValue = ({ key, value, parent, stack }) => {
    if (stack.length === 1 && key === 'type' && typeof value === 'string') {
      result.type = value
    } else if (stack.length === 2 && stack[1].key === 'data' && key === 'line_number') {
      if (typeof value === 'number') {
        data.line_number = value
      }
    } else if (stack.length === 3 && stack[1].key === 'data') {
      if (stack[2].key === 'submatches' && Array.isArray(parent)) {
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          typeof value.start !== 'number' ||
          typeof value.end !== 'number'
        ) {
          throw new SyntaxError('Invalid rg submatch')
        }
        if (data.submatches && data.submatches.length < maxMatches) {
          data.submatches.push({ start: value.start, end: value.end })
        }
        parent.pop()
      } else if (stack[2].key === 'path' && key === 'text' && typeof value === 'string') {
        data.path = { text: value }
      } else if (stack[2].key === 'lines' && typeof value === 'string') {
        if (key === 'text') {
          data.lines = { ...data.lines, text: value }
        }
        if (key === 'bytes') {
          data.lines = { ...data.lines, bytes: value }
        }
      }
    }
  }
  parser.write(line)
  if (!parser.isEnded) {
    parser.end()
  }
  return result
}

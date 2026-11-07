import * as StreamJson from 'stream-json/core/parser.js'
import type { ParserOptions, Token } from 'stream-json/core/parser.js'
import { none, type Many } from 'stream-chain/defs.js'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The installed parser exports jsonParser but omits its declaration.
const { jsonParser } = StreamJson as typeof StreamJson & {
  jsonParser: (options: ParserOptions) => (input: string | typeof none) => Many<Token> | typeof none
}

/** Bounds token batches while preserving caller-owned UTF-8 decoding. */
export function createJsonTokenReader(
  consume: (token: Token) => void,
  batchCodeUnits = 64 * 1024,
  retainScalar?: () => boolean
): {
  write: (text: string) => void
  end: () => void
} {
  if (!Number.isSafeInteger(batchCodeUnits) || batchCodeUnits < 1) {
    throw new RangeError('JSON token batch size must be a positive safe integer')
  }
  const parse = jsonParser({
    streamValues: false,
    packStrings: retainScalar === undefined,
    packNumbers: retainScalar === undefined,
    streamStrings: retainScalar !== undefined,
    streamNumbers: retainScalar !== undefined
  })
  let flushed = false
  let scalar: 'string' | 'number' | null = null
  let retained = false
  let value = ''
  const consumeToken = (token: Token): void => {
    if (token.name === 'startString' || token.name === 'startNumber') {
      scalar = token.name === 'startString' ? 'string' : 'number'
      retained = retainScalar?.() ?? true
      value = ''
    } else if (token.name === 'stringChunk' || token.name === 'numberChunk') {
      if (retained) {
        value += token.value
      }
    } else if (token.name === 'endString' || token.name === 'endNumber') {
      const packed = value
      value = ''
      consume({
        name: scalar === 'number' ? 'numberValue' : 'stringValue',
        value: retained ? packed : scalar === 'number' ? '0' : ''
      })
      scalar = null
    } else {
      consume(token)
    }
  }
  function run(input: string | typeof none): void {
    let batch: Many<Token> | typeof none
    try {
      if (flushed) {
        throw new Error('Call to a flushed pipe.')
      }
      if (input === none) {
        flushed = true
      }
      batch = parse(input)
    } catch (error) {
      if (error instanceof Error) {
        throw new SyntaxError(error.message)
      }
      throw error
    }
    if (batch !== none) {
      for (const token of batch.values) {
        consumeToken(token)
      }
    }
  }
  return {
    write(text) {
      for (let offset = 0; offset < text.length; offset += batchCodeUnits) {
        run(text.slice(offset, offset + batchCodeUnits))
      }
    },
    end() {
      run(none)
    }
  }
}

import parser, { type Token } from 'stream-json/core/parser.js'
import exec from 'stream-chain/exec.js'
import { none } from 'stream-chain/defs.js'

/** Bounds token batches while preserving caller-owned UTF-8 decoding. */
export function createJsonTokenReader(
  consume: (token: Token) => void,
  batchCodeUnits = 64 * 1024
): {
  write: (text: string) => void
  end: () => void
} {
  if (!Number.isSafeInteger(batchCodeUnits) || batchCodeUnits < 1) {
    throw new RangeError('JSON token batch size must be a positive safe integer')
  }
  const parse = exec(parser({ streamValues: false }))
  function run(input: string | typeof none): void {
    let consumerFailed = false
    try {
      const pending = parse(input, (token: Token) => {
        try {
          consume(token)
        } catch (error) {
          consumerFailed = true
          throw error
        }
      })
      if (pending) {
        throw new Error('JSON token reader requires a synchronous parser')
      }
    } catch (error) {
      if (!consumerFailed && error instanceof Error) {
        throw new SyntaxError(error.message)
      }
      throw error
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

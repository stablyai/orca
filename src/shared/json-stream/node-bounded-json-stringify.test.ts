import { describe, expect, it } from 'vitest'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from './node-bounded-json-stringify'

describe('stringifyJsonWithinByteLimit', () => {
  it('rejects a large root string before materializing escaped JSON', () => {
    const value = '\n'.repeat(1024 * 1024)

    expect(() => stringifyJsonWithinByteLimit(value, 1024)).toThrow(JsonStringifyByteLimitError)
  })

  it('measures raw JSON values before native serialization materializes them', () => {
    const createRawJson = (JSON as { rawJSON?: (value: string) => unknown }).rawJSON
    if (!createRawJson) {
      return
    }
    const value = createRawJson(JSON.stringify('x'.repeat(1024)))

    expect(() => stringifyJsonWithinByteLimit(value, 32)).toThrow(JsonStringifyByteLimitError)
  })
})

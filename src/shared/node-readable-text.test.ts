import { describe, expect, it } from 'vitest'
import {
  NodeReadableTextTooLargeError,
  readNodeReadableTextWithinLimit
} from './node-readable-text'

async function* chunks(values: unknown[]): AsyncGenerator<unknown> {
  yield* values
}

describe('readNodeReadableTextWithinLimit', () => {
  it('preserves accepted UTF-8 bytes split across chunks', async () => {
    const encoded = Buffer.from('hello 🌍')

    await expect(
      readNodeReadableTextWithinLimit(
        chunks([encoded.subarray(0, 8), encoded.subarray(8)]),
        encoded.byteLength
      )
    ).resolves.toBe('hello 🌍')
  })

  it('accepts input exactly at the byte limit', async () => {
    await expect(
      readNodeReadableTextWithinLimit(chunks(['ab', Buffer.from('cd')]), 4)
    ).resolves.toBe('abcd')
  })

  it('rejects before retaining input beyond the byte limit', async () => {
    await expect(readNodeReadableTextWithinLimit(chunks(['1234', '5']), 4)).rejects.toEqual(
      new NodeReadableTextTooLargeError(5, 4)
    )
  })

  it('does not let an unlimited sequence of empty chunks grow retained state', async () => {
    await expect(
      readNodeReadableTextWithinLimit(chunks(Array.from({ length: 10_000 }, () => '')), 0)
    ).resolves.toBe('')
  })
})

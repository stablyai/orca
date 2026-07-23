import { describe, expect, it, vi } from 'vitest'
import {
  stringifyWebRuntimeOutboundJson,
  WebRuntimeOutboundJsonLimitError
} from './web-runtime-outbound-json'

describe('bounded web runtime JSON serialization', () => {
  it('preserves ordinary JSON values and exact byte accounting', () => {
    const value = { text: 'hello', escaped: '\u0000\n', items: [1, true, null] }
    const serialized = JSON.stringify(value)

    expect(stringifyWebRuntimeOutboundJson(value, 1_000)).toEqual({
      serialized,
      byteLength: new TextEncoder().encode(serialized).byteLength
    })
  })

  it('accepts the exact limit and rejects one byte over it', () => {
    expect(stringifyWebRuntimeOutboundJson('🐋', 6)).toEqual({
      serialized: '"🐋"',
      byteLength: 6
    })
    expect(() => stringifyWebRuntimeOutboundJson('🐋x', 6)).toThrow(
      WebRuntimeOutboundJsonLimitError
    )
  })

  it('stops traversal immediately after an oversized member', () => {
    const readAfter = vi.fn(() => 'late')
    const value = {
      payload: 'x'.repeat(100),
      get after() {
        return readAfter()
      }
    }

    expect(() => stringifyWebRuntimeOutboundJson(value, 32)).toThrow(
      'Remote runtime JSON payload exceeds 32 bytes'
    )
    expect(readAfter).not.toHaveBeenCalled()
  })

  it('matches JSON omission, array null, escaping, and boxed primitive behavior', () => {
    const omitted = { ignored: undefined, kept: 1 }
    const array = [undefined, () => 'ignored', Symbol('ignored')]

    expect(stringifyWebRuntimeOutboundJson(omitted, 10).serialized).toBe('{"kept":1}')
    expect(stringifyWebRuntimeOutboundJson(array, 16).serialized).toBe('[null,null,null]')
    expect(stringifyWebRuntimeOutboundJson(new String('\u0000'), 8).serialized).toBe('"\\u0000"')
  })

  it('accepts shared containers at the exact serialized limit', () => {
    const sharedObject = { value: 1 }
    const sharedArray = [1, 2]
    for (const value of [
      [sharedObject, sharedObject],
      [sharedArray, sharedArray]
    ]) {
      const serialized = JSON.stringify(value)
      const byteLength = new TextEncoder().encode(serialized).byteLength
      expect(stringifyWebRuntimeOutboundJson(value, byteLength)).toEqual({
        serialized,
        byteLength
      })
    }
  })

  it('rejects oversized raw JSON before visiting later members', () => {
    const json = JSON as typeof JSON & { rawJSON?: (value: string) => unknown }
    if (!json.rawJSON) {
      return
    }
    const readAfter = vi.fn(() => 1)
    const value = {
      raw: json.rawJSON(`"${'x'.repeat(100)}"`),
      get after() {
        return readAfter()
      }
    }

    expect(() => stringifyWebRuntimeOutboundJson(value, 32)).toThrow(
      WebRuntimeOutboundJsonLimitError
    )
    expect(readAfter).not.toHaveBeenCalled()
  })

  it('reports root values omitted by JSON.stringify without retaining output', () => {
    expect(stringifyWebRuntimeOutboundJson(undefined, 1)).toEqual({
      serialized: undefined,
      byteLength: 0
    })
  })
})

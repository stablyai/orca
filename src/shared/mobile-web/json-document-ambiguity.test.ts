import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES } from './bridge-limits'
import { parseMobileWebBridgeMessageDocument } from './bridge-message-parser'

describe('JSON document ambiguity scanning', () => {
  it('rejects a wide array through the schema without overflowing the argument stack', () => {
    const raw = JSON.stringify(Array.from({ length: 150_000 }, () => 0))
    expect(Buffer.byteLength(raw)).toBeLessThan(MOBILE_WEB_BRIDGE_MAX_MESSAGE_BYTES)
    expect(parseMobileWebBridgeMessageDocument(raw, z.object({}))).toEqual({
      ok: false,
      error: 'invalid_message'
    })
  })
})

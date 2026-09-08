import { describe, expect, it } from 'vitest'
import {
  MobileWebHostRequestPayloadSchema,
  mobileWebHostPayloadByteLength,
  mobileWebHostUnsubscribeMethod
} from './host-rpc-contract'

describe('generic host payload transport', () => {
  it('preserves unknown domain fields but rejects unknown envelope fields', () => {
    const payload = {
      method: 'future.read',
      workspaceId: 'opaque',
      params: { future: { kind: 'new' } }
    }
    expect(MobileWebHostRequestPayloadSchema.parse(payload)).toEqual(payload)
    expect(
      MobileWebHostRequestPayloadSchema.safeParse({ ...payload, nativeAuthority: true }).success
    ).toBe(false)
  })
  it('derives the desktop cancel name from the subscribe name, and nothing else', () => {
    expect(mobileWebHostUnsubscribeMethod('mobileWeb.files.watch')).toBe('mobileWeb.files.unwatch')
    expect(mobileWebHostUnsubscribeMethod('mobileWeb.session.subscribe')).toBe(
      'mobileWeb.session.unsubscribe'
    )
    expect(mobileWebHostUnsubscribeMethod('mobileWeb.nativeChat.subscribe')).toBe(
      'mobileWeb.nativeChat.unsubscribe'
    )
    expect(mobileWebHostUnsubscribeMethod('mobileWeb.files.read')).toBeUndefined()
    expect(mobileWebHostUnsubscribeMethod('mobileWeb.files.unwatch')).toBeUndefined()
  })

  it('reports the encoded length once for callers that also need the verdict', () => {
    expect(mobileWebHostPayloadByteLength({ future: 'value' })).toBe(
      new TextEncoder().encode(JSON.stringify({ future: 'value' })).byteLength
    )
    expect(mobileWebHostPayloadByteLength('é'.repeat(310 * 1024))).toBeUndefined()
    expect(mobileWebHostPayloadByteLength(() => {})).toBeUndefined()
  })

  it('accepts JSON within the byte envelope regardless of depth or node count', () => {
    let nested: unknown = null
    for (let i = 0; i < 34; i++) {
      nested = { nested }
    }
    expect(mobileWebHostPayloadByteLength(nested)).toBeDefined()
    expect(mobileWebHostPayloadByteLength(Array(40_001).fill(null))).toBeDefined()
    expect(mobileWebHostPayloadByteLength({ optional: undefined, value: true })).toBeDefined()
    const cyclic = { self: null as unknown }
    cyclic.self = cyclic
    expect(mobileWebHostPayloadByteLength(cyclic)).toBeUndefined()
  })
})

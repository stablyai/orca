import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { bandwidthResponse } from './remote-runtime-bandwidth-fixture'
import {
  compressRuntimeSnapshotResponse,
  decodeRuntimeSnapshotResponse,
  MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES
} from './remote-runtime-snapshot-compression'

describe('bounded runtime snapshot compression', () => {
  it('keeps the legacy reply when input exceeds structural limits', () => {
    const response = JSON.parse(bandwidthResponse(1))
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 65; depth++) {
      nested = [nested]
    }
    response.result.futureField = nested
    const serialized = JSON.stringify(response)
    expect(compressRuntimeSnapshotResponse(serialized)).toBe(serialized)
  })

  it('does not hide malformed input JSON', () => {
    expect(() => compressRuntimeSnapshotResponse('{invalid')).toThrow(SyntaxError)
  })

  it('roundtrips every field without retaining dictionary state between frames', () => {
    const response = bandwidthResponse(1)
    const compressed = compressRuntimeSnapshotResponse(response)
    expect(Buffer.byteLength(compressed)).toBeLessThan(Buffer.byteLength(response) * 0.7)
    expect(decodeRuntimeSnapshotResponse(JSON.parse(compressed), true)).toEqual(
      JSON.parse(response)
    )
    compressRuntimeSnapshotResponse(bandwidthResponse(50))
    expect(compressRuntimeSnapshotResponse(response)).toBe(compressed)
  })

  it('leaves small, oversized and non-snapshot replies untouched', () => {
    for (const response of [
      '{"ok":false,"error":{"message":"secret"}}',
      JSON.stringify({ ok: true, result: { type: 'end' } }),
      JSON.stringify({
        ok: true,
        streaming: true,
        result: { type: 'updated', data: 'x'.repeat(MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES) }
      })
    ]) {
      expect(compressRuntimeSnapshotResponse(response)).toBe(response)
    }
  })

  it('rejects unsolicited compression and malformed compressed payloads instead of downgrading', () => {
    const raw = JSON.parse(compressRuntimeSnapshotResponse(bandwidthResponse(1)))
    expect(() => decodeRuntimeSnapshotResponse(raw, false)).toThrow()
    for (const compressedResult of [
      { ...raw.compressedResult, encoding: 'gzip' },
      { ...raw.compressedResult, data: 'not base64!' },
      { ...raw.compressedResult, bytes: 1 },
      { ...raw.compressedResult, bytes: MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES + 1 },
      {
        encoding: 'deflate-raw',
        bytes: 1,
        data: deflateRawSync('x'.repeat(MAX_RUNTIME_SNAPSHOT_COMPRESSION_BYTES * 2)).toString(
          'base64'
        )
      }
    ]) {
      expect(() => decodeRuntimeSnapshotResponse({ ...raw, compressedResult }, true)).toThrow()
    }
  })

  it('accepts legacy envelopes unchanged', () => {
    const response = JSON.parse(bandwidthResponse(1))
    expect(decodeRuntimeSnapshotResponse(response, true)).toBe(response)
  })

  it('keeps a valid deeply nested legacy frame when the sidecar would exceed JSON depth limits', () => {
    const response = JSON.parse(bandwidthResponse(1))
    let nested: unknown = 'leaf'
    for (let depth = 0; depth < 61; depth++) {
      nested = [nested]
    }
    response.result.futureField = nested
    const serialized = JSON.stringify(response)
    expect(compressRuntimeSnapshotResponse(serialized)).toBe(serialized)
  })

  it('keeps equal-length secrets and attacker-controlled text outside the compression context', () => {
    const response = JSON.parse(bandwidthResponse(1))
    const secret = 'private-token-123456789'
    const different = 'unrelated-text-98765432'
    expect(secret.length).toBe(different.length)
    response.result.tabs[0].agentStatus.prompt = secret
    response.result.tabs[1].title = secret
    const match = JSON.parse(compressRuntimeSnapshotResponse(JSON.stringify(response)))
    response.result.tabs[1].title = different
    const mismatch = JSON.parse(compressRuntimeSnapshotResponse(JSON.stringify(response)))
    expect(match.compressedResult.data).toBe(mismatch.compressedResult.data)
    expect(JSON.stringify(match).length).toBe(JSON.stringify(mismatch).length)
    const dictionaryInput = inflateRawSync(
      Buffer.from(match.compressedResult.data, 'base64')
    ).toString()
    expect(dictionaryInput).not.toContain(secret)
    expect(dictionaryInput).not.toContain('prompt')
  })

  it('roundtrips unknown keys, prototype-looking fields, and non-generated IDs without compressing them', () => {
    const response = JSON.parse(bandwidthResponse(1))
    response.result = {
      ...response.result,
      ...JSON.parse(
        '{"__proto__":{"secret":"retained"},"future-secret-key":"retained","$literal:0":"retained"}'
      )
    }
    expect(Object.hasOwn(response.result, '__proto__')).toBe(true)
    response.result.tabs[0].id = '/private/path/with-secret'
    response.result.id = '00000000-0000-4000-8000-000000000000'
    const serialized = JSON.stringify(response)
    const raw = JSON.parse(compressRuntimeSnapshotResponse(serialized))
    expect(decodeRuntimeSnapshotResponse(raw, true)).toEqual(JSON.parse(serialized))
    const dictionaryInput = inflateRawSync(
      Buffer.from(raw.compressedResult.data, 'base64')
    ).toString()
    expect(dictionaryInput).not.toContain('private/path')
    expect(dictionaryInput).not.toContain('future-secret-key')
    expect(dictionaryInput).not.toContain('__proto__')
    expect(dictionaryInput).not.toContain(response.result.id)
    expect({}).not.toHaveProperty('secret')
  })

  it('never grows incompressible replies and preserves arbitrary opaque values', () => {
    const response = JSON.stringify({
      ok: true,
      streaming: true,
      result: { type: 'updated', payload: randomBytes(48 * 1024).toString('base64') }
    })
    expect(compressRuntimeSnapshotResponse(response)).toBe(response)
  })

  it('rejects ambiguous envelopes and repeated literal references', () => {
    const raw = JSON.parse(compressRuntimeSnapshotResponse(bandwidthResponse(1)))
    expect(() => decodeRuntimeSnapshotResponse({ ...raw, result: {} }, true)).toThrow()
    const structure = inflateRawSync(Buffer.from(raw.compressedResult.data, 'base64')).toString()
    const corrupt = structure.replace('$literal:1', '$literal:0')
    raw.compressedResult.data = deflateRawSync(corrupt).toString('base64')
    raw.compressedResult.bytes = Buffer.byteLength(corrupt)
    expect(() => decodeRuntimeSnapshotResponse(raw, true)).toThrow()
  })
})

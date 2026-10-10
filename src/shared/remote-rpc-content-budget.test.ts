import { describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from './remote-runtime-memory-limits'
import {
  REMOTE_RPC_MAX_CONTENT_BYTES,
  remoteRpcContentBudget,
  remoteRpcResultExceedsContentBudget
} from './remote-rpc-content-budget'

describe('remoteRpcContentBudget', () => {
  it('measures the complete serialized result, including additive fields', () => {
    const result = { content: '', futureMetadata: 'x'.repeat(128) }
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')

    expect(remoteRpcResultExceedsContentBudget(result, bytes, ['content'])).toBe(false)
    expect(remoteRpcResultExceedsContentBudget(result, bytes - 1, ['content'])).toBe(true)
  })

  it('reuses exact measurements for a shared result object', () => {
    const result = { content: '\n'.repeat(64 * 1024), isBinary: false }
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt')
    try {
      expect(remoteRpcResultExceedsContentBudget(result, bytes, ['content'])).toBe(false)
      const firstCalls = charCodeAt.mock.calls.length
      expect(firstCalls).toBeGreaterThan(result.content.length)

      expect(remoteRpcResultExceedsContentBudget(result, bytes - 1, ['content'])).toBe(true)
      expect(charCodeAt.mock.calls.length - firstCalls).toBeLessThan(100)
    } finally {
      charCodeAt.mockRestore()
    }
  })

  it('reuses raw measurements for a shared oversized result', () => {
    const result = { content: 'A'.repeat(4 * 1024 * 1024), isBinary: false }
    const byteLength = vi.spyOn(Buffer, 'byteLength')
    const contentMeasurementCalls = () =>
      byteLength.mock.calls.filter(([value]) => value === result.content).length
    try {
      expect(remoteRpcResultExceedsContentBudget(result, result.content.length, ['content'])).toBe(
        true
      )
      expect(contentMeasurementCalls()).toBe(1)

      expect(
        remoteRpcResultExceedsContentBudget(result, result.content.length - 128, ['content'])
      ).toBe(true)
      expect(contentMeasurementCalls()).toBe(1)
    } finally {
      byteLength.mockRestore()
    }
  })

  it('re-evaluates a cached raw measurement under a larger budget', () => {
    const result = { content: 'A'.repeat(1_000), isBinary: false }
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')

    expect(remoteRpcResultExceedsContentBudget(result, 900, ['content'])).toBe(true)
    expect(remoteRpcResultExceedsContentBudget(result, bytes, ['content'])).toBe(false)
  })

  it('does not reuse a truncated measurement for a larger budget', () => {
    const result = { content: String.fromCharCode(1).repeat(1_000), isBinary: false }
    const bytes = Buffer.byteLength(JSON.stringify(result), 'utf8')

    expect(bytes).toBeGreaterThan(1_150)
    expect(remoteRpcResultExceedsContentBudget(result, 1_050, ['content'])).toBe(true)
    expect(remoteRpcResultExceedsContentBudget(result, 1_150, ['content'])).toBe(true)
  })

  it('charges an escape-dense echoed request id to a file preview reply', () => {
    const id = '\u0001'.repeat(8_192)
    const replyBytes = (contentBytes: number) =>
      Buffer.byteLength(
        JSON.stringify({
          id,
          ok: true,
          result: {
            content: 'A'.repeat(contentBytes),
            isBinary: true,
            isImage: true,
            mimeType: 'image/png'
          },
          _meta: { runtimeId: '00000000-0000-4000-8000-000000000000' }
        }),
        'utf8'
      )

    expect(replyBytes(REMOTE_RPC_MAX_CONTENT_BYTES)).toBeGreaterThan(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
    expect(replyBytes(remoteRpcContentBudget(id))).toBeLessThanOrEqual(
      REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
    )
  })
})

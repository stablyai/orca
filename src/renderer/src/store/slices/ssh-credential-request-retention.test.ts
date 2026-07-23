import { describe, expect, it } from 'vitest'
import { getUtf8ByteLength } from '../../../../shared/utf8-byte-limits'
import {
  retainSshCredentialRequest,
  type SshCredentialRequest,
  type SshCredentialRequestRetentionBounds
} from './ssh-credential-request-retention'

const TEST_BOUNDS: SshCredentialRequestRetentionBounds = {
  maxRequests: 2,
  maxRequestIdBytes: 8,
  maxTargetIdBytes: 8,
  maxDetailBytes: 8
}

function request(requestId: string, detail = 'prompt'): SshCredentialRequest {
  return {
    requestId,
    targetId: 'target',
    kind: 'password',
    detail
  }
}

describe('SSH credential request retention', () => {
  it('preserves ordinary requests in FIFO order', () => {
    const first = retainSshCredentialRequest([], request('first'), TEST_BOUNDS)
    const second = retainSshCredentialRequest(first.queue, request('second'), TEST_BOUNDS)

    expect(second.queue.map((entry) => entry.requestId)).toEqual(['first', 'second'])
    expect(second.notice).toBeUndefined()
  })

  it('deduplicates repeated request IDs without replacing their FIFO position', () => {
    const original = [request('same', 'original')]
    const result = retainSshCredentialRequest(original, request('same', 'replacement'), TEST_BOUNDS)

    expect(result.queue).toBe(original)
    expect(result.notice).toEqual({
      action: 'dropped',
      reason: 'duplicate-request-id',
      limit: TEST_BOUNDS.maxRequests
    })
  })

  it('drops new requests after the simultaneous prompt cap', () => {
    const original = [request('first'), request('second')]
    const result = retainSshCredentialRequest(original, request('third'), TEST_BOUNDS)

    expect(result.queue).toBe(original)
    expect(result.notice).toEqual({
      action: 'dropped',
      reason: 'queue-full',
      limit: TEST_BOUNDS.maxRequests
    })
  })

  it.each([
    ['requestId', 'oversized-request-id'],
    ['targetId', 'oversized-target-id']
  ] as const)('drops requests with an oversized %s', (field, reason) => {
    const oversized = { ...request('id'), [field]: '😀😀😀' }
    const result = retainSshCredentialRequest([], oversized, TEST_BOUNDS)

    expect(result.queue).toEqual([])
    expect(result.notice).toMatchObject({ action: 'dropped', reason })
  })

  it('truncates display detail on a UTF-8 code point boundary', () => {
    const result = retainSshCredentialRequest([], request('id', 'a😀b😀c'), TEST_BOUNDS)

    expect(result.queue[0]?.detail).toBe('a😀b')
    expect(getUtf8ByteLength(result.queue[0]?.detail ?? '')).toBeLessThanOrEqual(
      TEST_BOUNDS.maxDetailBytes
    )
    expect(result.notice).toEqual({
      action: 'truncated',
      field: 'detail',
      limit: TEST_BOUNDS.maxDetailBytes
    })
  })
})

import { describe, expect, it } from 'vitest'
import {
  createOrchestrationRetryRequestId,
  isOrchestrationRetryRequestId,
  orchestrationRetryRequestIssuedAtMs
} from './orchestration-retry-request-id'

describe('orchestration retry request identity', () => {
  it('encodes the RFC 9562 timestamp, version and variant with random remaining bits', () => {
    const issuedAtMs = 0x0123456789ab
    const ids = Array.from({ length: 100 }, () => createOrchestrationRetryRequestId(issuedAtMs))
    for (const id of ids) {
      expect(id).toMatch(/^01234567-89ab-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
      expect(isOrchestrationRetryRequestId(id)).toBe(true)
      expect(orchestrationRetryRequestIssuedAtMs(id)).toBe(issuedAtMs)
      expect(orchestrationRetryRequestIssuedAtMs(id.toUpperCase())).toBe(issuedAtMs)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('keeps v4 and other untimed identities in the legacy namespace', () => {
    expect(orchestrationRetryRequestIssuedAtMs('11111111-2222-4333-8444-555555555555')).toBeNull()
    expect(orchestrationRetryRequestIssuedAtMs('11111111-2222-1333-8444-555555555555')).toBeNull()
    expect(orchestrationRetryRequestIssuedAtMs('11111111-2222-7333-4444-555555555555')).toBeNull()
    expect(orchestrationRetryRequestIssuedAtMs('not-a-uuid')).toBeNull()
  })

  it.each([-1, 1.5, Number.NaN, Infinity, 0x1000000000000])(
    'rejects invalid issue time %s',
    (time) => {
      expect(() => createOrchestrationRetryRequestId(time)).toThrow(RangeError)
    }
  )

  it.each([0, 0xffffffffffff])('preserves timestamp boundary %s', (time) => {
    expect(orchestrationRetryRequestIssuedAtMs(createOrchestrationRetryRequestId(time))).toBe(time)
  })
})

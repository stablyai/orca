import { describe, expect, it } from 'vitest'
import { parseScheduledWaitUntil } from './orchestration-scheduled-wait'
import { getOptionalStructuredMessagePayload } from '../cli/handlers/orchestration/message-payload'

const NOW = Date.parse('2026-11-03T12:00:00Z')

describe('scheduled wait arguments', () => {
  it.each([
    ['30s', 30_000],
    ['5m', 300_000],
    ['4h', 14_400_000],
    ['1d', 86_400_000]
  ] as const)('resolves %s relative to now', (value, milliseconds) => {
    expect(parseScheduledWaitUntil(value, NOW)).toBe(new Date(NOW + milliseconds).toISOString())
  })

  it('accepts explicit timestamps with timezone and rejects local or expired values', () => {
    expect(parseScheduledWaitUntil('2026-11-03T08:00:00-08:00', NOW)).toBe(
      '2026-11-03T16:00:00.000Z'
    )
    expect(parseScheduledWaitUntil('2028-02-29T10:00:00Z', NOW)).toBe('2028-02-29T10:00:00.000Z')
    for (const value of [
      '0h',
      '-1h',
      '2026-11-03T11:00:00Z',
      '2026-11-04T12:00:00',
      '2026-02-29T10:00:00Z',
      '2026-02-30T10:00:00Z',
      '2026-11-04T24:00:00Z',
      'tomorrow',
      '1e99h'
    ]) {
      expect(() => parseScheduledWaitUntil(value, NOW)).toThrow('wait-until')
    }
  })

  it('encodes a structured wait payload with its Dispatch and requires a status and reason', () => {
    const flags = new Map<string, string | boolean>([
      ['dispatch-id', 'ctx_worker'],
      ['type', 'status'],
      ['wait-until', '4h'],
      ['body', 'Next scheduled check']
    ])
    expect(JSON.parse(getOptionalStructuredMessagePayload(flags)!)).toMatchObject({
      dispatchId: 'ctx_worker',
      waitUntil: expect.any(String)
    })
    flags.delete('body')
    expect(() => getOptionalStructuredMessagePayload(flags)).toThrow('reason')
    flags.set('body', 'wait')
    flags.set('type', 'heartbeat')
    expect(() => getOptionalStructuredMessagePayload(flags)).toThrow('status')
  })
})

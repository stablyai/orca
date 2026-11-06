import { describe, expect, it } from 'vitest'
import { FRAME_EVENTS, readPanelPongId } from './plugin-frame-bridge'
import { pluginEnvelopeSchema } from './plugin-protocol'

/** Hand-rolled pong reading avoids Zod’s ~90x rejection cost; pin exact schema acceptance parity. */

const pong = (payload: unknown, extra: Record<string, unknown> = {}): unknown => ({
  orca: 1,
  kind: 'evt',
  event: FRAME_EVENTS.pong,
  payload,
  ...extra
})

const CASES: unknown[] = [
  pong(0),
  pong(7),
  pong(Number.MAX_SAFE_INTEGER),
  // Above the safe range zod's .int() refuses, though Number.isInteger accepts.
  pong(Number.MAX_SAFE_INTEGER + 1),
  pong(2 ** 60),
  pong(1e100),
  pong(Number.MAX_VALUE),
  pong(7, { extra: 'ignored' }),
  pong(-1),
  pong(1.5),
  pong(Number.NaN),
  pong(Number.POSITIVE_INFINITY),
  pong('7'),
  pong(null),
  pong(undefined),
  pong(7, { orca: 2 }),
  pong(7, { kind: 'req' }),
  { orca: 1, kind: 'evt', event: 'ping', payload: 7 },
  { type: 'orca-panel-pong', pingId: 7 },
  'pong',
  null,
  undefined,
  42,
  []
]

const schemaPong = (data: unknown): boolean => {
  const parsed = pluginEnvelopeSchema.safeParse(data)
  return (
    parsed.success &&
    parsed.data.kind === 'evt' &&
    parsed.data.event === FRAME_EVENTS.pong &&
    Number.isSafeInteger(parsed.data.payload) &&
    Number(parsed.data.payload) >= 0
  )
}

describe('readPanelPongId', () => {
  it.each(CASES.map((data, index) => [index, data]))(
    'agrees with the envelope schema on case %i',
    (_index, data) => {
      expect(readPanelPongId(data) !== null).toBe(schemaPong(data))
    }
  )

  it('returns the ping id the watchdog must correlate against', () => {
    expect(readPanelPongId(pong(7))).toBe(7)
    expect(readPanelPongId(pong(0))).toBe(0)
  })
})

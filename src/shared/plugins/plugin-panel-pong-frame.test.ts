import { describe, expect, it } from 'vitest'
import { PANEL_PONG_TYPE, panelPongSchema, readPanelPongId } from './plugin-panel-bridge'

/** `readPanelPongId` is hand-rolled to avoid zod's ~90x rejected-parse
 *  allocation cost on the guest-controlled bridge path. It must therefore
 *  accept exactly what `panelPongSchema` accepts, forever. */

const CASES: unknown[] = [
  { type: PANEL_PONG_TYPE, pingId: 0 },
  { type: PANEL_PONG_TYPE, pingId: 7 },
  { type: PANEL_PONG_TYPE, pingId: Number.MAX_SAFE_INTEGER },
  // Above the safe range zod's .int() refuses, though Number.isInteger accepts.
  { type: PANEL_PONG_TYPE, pingId: Number.MAX_SAFE_INTEGER + 1 },
  { type: PANEL_PONG_TYPE, pingId: 2 ** 60 },
  { type: PANEL_PONG_TYPE, pingId: 1e100 },
  { type: PANEL_PONG_TYPE, pingId: Number.MAX_VALUE },
  { type: PANEL_PONG_TYPE, pingId: 7, extra: 'ignored' },
  { type: PANEL_PONG_TYPE, pingId: -1 },
  { type: PANEL_PONG_TYPE, pingId: 1.5 },
  { type: PANEL_PONG_TYPE, pingId: Number.NaN },
  { type: PANEL_PONG_TYPE, pingId: Number.POSITIVE_INFINITY },
  { type: PANEL_PONG_TYPE, pingId: '7' },
  { type: PANEL_PONG_TYPE, pingId: null },
  { type: PANEL_PONG_TYPE },
  { type: 'orca-panel-action', pingId: 7 },
  { pingId: 7 },
  'orca-panel-pong',
  null,
  undefined,
  42,
  []
]

describe('readPanelPongId', () => {
  it.each(CASES.map((data, index) => [index, data]))(
    'agrees with panelPongSchema on case %i',
    (_index, data) => {
      expect(readPanelPongId(data) !== null).toBe(panelPongSchema.safeParse(data).success)
    }
  )

  it('returns the pingId the watchdog must correlate against', () => {
    expect(readPanelPongId({ type: PANEL_PONG_TYPE, pingId: 7 })).toBe(7)
    expect(readPanelPongId({ type: PANEL_PONG_TYPE, pingId: 0 })).toBe(0)
  })
})

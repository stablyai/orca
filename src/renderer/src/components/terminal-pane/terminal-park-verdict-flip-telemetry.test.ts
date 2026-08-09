import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT,
  TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
  recordParkVerdictFlips,
  type ParkVerdictFlipRecord
} from './terminal-park-verdict-flip-telemetry'

const recordBreadcrumb = vi.fn()
vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: (name: string, data?: unknown) => recordBreadcrumb(name, data)
}))

const TAB = 'tab-1'

function observe(args: {
  records: Map<string, ParkVerdictFlipRecord>
  parked: boolean
  nowMs: number
  liveTabIds?: ReadonlySet<string>
}): void {
  recordParkVerdictFlips({
    records: args.records,
    liveTabIds: args.liveTabIds ?? new Set([TAB]),
    nextParkedTabIds: args.parked ? new Set([TAB]) : new Set(),
    nowMs: args.nowMs
  })
}

beforeEach(() => recordBreadcrumb.mockClear())

describe('recordParkVerdictFlips', () => {
  it('stays silent for a stable verdict', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let index = 0; index < 100; index += 1) {
      observe({ records, parked: true, nowMs: 1_000 + index * 1_000 })
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(records.get(TAB)?.flips).toBe(0)
  })

  it('emits one breadcrumb per window once the verdict churns', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let index = 0; index < 40; index += 1) {
      observe({ records, parked: index % 2 === 0, nowMs: 1_000 + index * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ tabId: TAB, flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT })
    )
  })

  it('reports elapsed time for tight and slow churn', () => {
    const tightRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let index = 0; index < 40; index += 1) {
      observe({ records: tightRecords, parked: index % 2 === 0, nowMs: 1_000 + index })
    }
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT, elapsedMs: 12 })
    )

    recordBreadcrumb.mockClear()
    const slowRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let index = 0; index < 13; index += 1) {
      observe({ records: slowRecords, parked: index % 2 === 0, nowMs: 1_000 + index * 4_000 })
    }
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT, elapsedMs: 48_000 })
    )
  })

  it('re-arms after the window elapses', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let index = 0; index < 40; index += 1) {
      observe({ records, parked: index % 2 === 0, nowMs: 1_000 + index * 10 })
    }
    const laterMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let index = 0; index < 40; index += 1) {
      observe({ records, parked: index % 2 === 0, nowMs: laterMs + index * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(2)
  })

  it('treats backwards and exactly elapsed clocks as fresh windows', () => {
    const backward = new Map<string, ParkVerdictFlipRecord>()
    observe({ records: backward, parked: true, nowMs: 10_000_000 })
    observe({ records: backward, parked: false, nowMs: 1_000 })
    expect(backward.get(TAB)).toMatchObject({ windowStartMs: 1_000, flips: 1 })

    const elapsed = new Map<string, ParkVerdictFlipRecord>()
    observe({ records: elapsed, parked: true, nowMs: 1_000 })
    observe({
      records: elapsed,
      parked: false,
      nowMs: 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS
    })
    expect(elapsed.get(TAB)).toMatchObject({
      windowStartMs: 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS,
      flips: 1
    })
  })

  it('honors window and notice overrides', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let index = 0; index < 10; index += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB]),
        nextParkedTabIds: index % 2 === 0 ? new Set([TAB]) : new Set(),
        nowMs: 1_000 + index,
        flipWindowMs: 500,
        noticeLimit: 3
      })
    }

    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ flips: 3, windowMs: 500 })
    )
  })

  it('keeps tabs independent and drops closed tabs', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const other = 'tab-2'
    for (let index = 0; index < 40; index += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB, other]),
        nextParkedTabIds: index % 2 === 0 ? new Set([TAB, other]) : new Set([other]),
        nowMs: 1_000 + index * 10
      })
    }
    expect(records.get(other)?.flips).toBe(0)

    recordParkVerdictFlips({
      records,
      liveTabIds: new Set(),
      nextParkedTabIds: new Set(),
      nowMs: 2_000
    })
    expect(records.size).toBe(0)
  })
})

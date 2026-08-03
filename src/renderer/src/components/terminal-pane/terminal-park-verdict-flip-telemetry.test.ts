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

beforeEach(() => {
  recordBreadcrumb.mockClear()
})

describe('recordParkVerdictFlips', () => {
  it('stays silent for a stable verdict', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 100; i += 1) {
      observe({ records, parked: true, nowMs: 1_000 + i * 1_000 })
    }

    expect(recordBreadcrumb).not.toHaveBeenCalled()
    expect(records.get(TAB)?.flips).toBe(0)
  })

  it('emits one breadcrumb per window once the verdict churns', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ tabId: TAB, flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT })
    )
  })

  // Why: flips saturates at the notice limit, so elapsedMs is the only field
  // that tells a runaway loop apart from slow churn — assert both ends.
  it('reports elapsedMs so a tight loop is distinguishable from slow churn', () => {
    const tightRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records: tightRecords, parked: i % 2 === 0, nowMs: 1_000 + i })
    }
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT, elapsedMs: 12 })
    )

    recordBreadcrumb.mockClear()

    const slowRecords = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 13; i += 1) {
      observe({ records: slowRecords, parked: i % 2 === 0, nowMs: 1_000 + i * 4_000 })
    }
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ flips: TERMINAL_TAB_PARK_FLIP_NOTICE_LIMIT, elapsedMs: 48_000 })
    )
  })

  it('re-arms after the window elapses', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: 1_000 + i * 10 })
    }
    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)

    const laterMs = 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS * 2
    for (let i = 0; i < 40; i += 1) {
      observe({ records, parked: i % 2 === 0, nowMs: laterMs + i * 10 })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(2)
  })

  // Why: an unclamped backwards jump would freeze the window and suppress the
  // very signal this module exists to capture.
  it('treats a backwards clock jump as a fresh window', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 10_000_000 })
    observe({ records, parked: false, nowMs: 1_000 })

    expect(records.get(TAB)?.windowStartMs).toBe(1_000)
    expect(records.get(TAB)?.flips).toBe(1)
  })

  // Why: >= is the boundary operator; a > regression would silently stretch the
  // window and delay every notice by one full period.
  it('treats an exactly-elapsed window as expired', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })
    observe({ records, parked: false, nowMs: 1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS })

    expect(records.get(TAB)?.windowStartMs).toBe(1_000 + TERMINAL_TAB_PARK_FLIP_WINDOW_MS)
    expect(records.get(TAB)?.flips).toBe(1)
  })

  it('honours flipWindowMs and noticeLimit overrides', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    for (let i = 0; i < 10; i += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB]),
        nextParkedTabIds: i % 2 === 0 ? new Set([TAB]) : new Set(),
        nowMs: 1_000 + i,
        flipWindowMs: 500,
        noticeLimit: 3
      })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ flips: 3, windowMs: 500 })
    )
  })

  it('keeps per-tab windows and notices independent', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    const other = 'tab-2'
    for (let i = 0; i < 40; i += 1) {
      recordParkVerdictFlips({
        records,
        liveTabIds: new Set([TAB, other]),
        // Why: TAB churns every call, other stays parked throughout.
        nextParkedTabIds: i % 2 === 0 ? new Set([TAB, other]) : new Set([other]),
        nowMs: 1_000 + i * 10
      })
    }

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith(
      'terminal_park_verdict_churn',
      expect.objectContaining({ tabId: TAB })
    )
    expect(records.get(other)?.flips).toBe(0)
  })

  it('drops records for tabs that no longer exist', () => {
    const records = new Map<string, ParkVerdictFlipRecord>()
    observe({ records, parked: true, nowMs: 1_000 })

    recordParkVerdictFlips({
      records,
      liveTabIds: new Set(),
      nextParkedTabIds: new Set(),
      nowMs: 2_000
    })

    expect(records.size).toBe(0)
  })
})

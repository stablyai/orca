import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureHardeningRetryBudget,
  mayAttemptHardening,
  recordHardeningOutcome
} from './secure-path-hardening-retry-budget'
import {
  setSecurePathHardeningReporter,
  type SecurePathHardeningReport
} from './secure-path-hardening-report'

const PATH = 'C:\\Users\\me\\.orca\\secret.json'
const OTHER = 'C:\\Users\\me\\.orca\\other.json'
const MINUTE = 60_000

describe('secure path hardening retry budget', () => {
  /** Elapsed monotonic time, which is what the budget measures. */
  let clock = 0
  /** The wall clock, which it must not measure: it steps backwards on real machines. */
  let wallClock = 0
  let reports: SecurePathHardeningReport[] = []

  beforeEach(() => {
    clock = 1_000_000
    wallClock = Date.parse('2026-01-01T00:00:00Z')
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    vi.spyOn(Date, 'now').mockImplementation(() => wallClock)
    reports = []
    setSecurePathHardeningReporter((entry) => reports.push(entry))
    configureHardeningRetryBudget({
      maxEntries: 64,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 65_536
    })
  })

  afterEach(() => {
    setSecurePathHardeningReporter(null)
    vi.restoreAllMocks()
  })

  /** Drives the loop the read path drives: attempt when allowed, record the failure, advance. */
  function pollUntil(elapsedMs: number, stepMs: number, restricted = false): number[] {
    const attemptedAt: number[] = []
    const startedAt = clock
    while (clock - startedAt <= elapsedMs) {
      if (mayAttemptHardening(PATH)) {
        attemptedAt.push(clock - startedAt)
        recordHardeningOutcome(PATH, restricted)
      }
      clock += stepMs
      wallClock += stepMs
    }
    return attemptedAt
  }

  it('re-probes on the documented curve rather than on every read', () => {
    // Six hours of polling every 30s: 720 reads, and only the backoff decides how many run.
    const attemptedAt = pollUntil(6 * 60 * MINUTE, 30_000)

    expect(attemptedAt.slice(0, 6).map((ms) => ms / MINUTE)).toEqual([0, 1, 3, 7, 15, 31])
    const trailingGaps = attemptedAt
      .slice(-4)
      .map((ms, index, all) => (all[index + 1]! - ms) / MINUTE)
    expect(trailingGaps.slice(0, -1)).toEqual([30, 30, 30])
  })

  /** Backwards wall-clock steps previously held paths below retry delay until time caught up; monotonic elapsed time must keep probing. */
  it('re-probes after a backwards clock step rather than waiting for the wall clock', () => {
    pollUntil(6 * 60 * MINUTE, 30_000)

    wallClock -= 365 * 24 * 60 * MINUTE
    clock += 31 * MINUTE

    expect(mayAttemptHardening(PATH)).toBe(true)
  })

  it('announces the degraded state once, not once per failure', () => {
    pollUntil(6 * 60 * MINUTE, 30_000)

    const throttled = reports.filter((entry) => entry.stage === 'throttled')
    expect(throttled).toHaveLength(1)
    expect(throttled[0]).toMatchObject({ targetPath: PATH, stage: 'throttled' })
  })

  it('announces recovery when a throttled path hardens again, and resets the curve', () => {
    pollUntil(10 * MINUTE, 30_000)
    expect(reports.filter((entry) => entry.stage === 'throttled')).toHaveLength(1)

    recordHardeningOutcome(PATH, true)

    expect(reports.filter((entry) => entry.stage === 'recovered')).toMatchObject([
      { targetPath: PATH, stage: 'recovered' }
    ])
    // Record cleared: the next failure starts at the floor rather than the ceiling.
    expect(mayAttemptHardening(PATH)).toBe(true)
    recordHardeningOutcome(PATH, false)
    clock += 59_000
    expect(mayAttemptHardening(PATH)).toBe(false)
    clock += 2_000
    expect(mayAttemptHardening(PATH)).toBe(true)
  })

  it('stays silent about recovery for a path that never reached the degraded state', () => {
    recordHardeningOutcome(PATH, false)
    recordHardeningOutcome(PATH, true)

    expect(reports).toEqual([])
  })

  it('budgets each path separately', () => {
    recordHardeningOutcome(PATH, false)

    expect(mayAttemptHardening(PATH)).toBe(false)
    expect(mayAttemptHardening(OTHER)).toBe(true)
  })

  /** A second importer may have no configuration; throwing there made async hardening crash main.
   * Import only the budget so secure-file cannot hide the missing defaults. */
  it('defaults its bounds when nothing configured it', async () => {
    vi.resetModules()
    const budget = await import('./secure-path-hardening-retry-budget.js')

    expect(budget.mayAttemptHardening(PATH)).toBe(true)
    expect(() => budget.recordHardeningOutcome(PATH, false)).not.toThrow()
    expect(budget.mayAttemptHardening(PATH)).toBe(false)
    expect(budget.mayAttemptHardening(OTHER)).toBe(true)
  })
})

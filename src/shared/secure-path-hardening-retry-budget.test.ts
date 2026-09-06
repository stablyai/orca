import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureHardeningRetryBudget,
  hardeningRetryDelayMs,
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

  it('doubles the delay after each consecutive failure, up to the ceiling', () => {
    expect(hardeningRetryDelayMs(1)).toBe(1 * MINUTE)
    expect(hardeningRetryDelayMs(2)).toBe(2 * MINUTE)
    expect(hardeningRetryDelayMs(3)).toBe(4 * MINUTE)
    expect(hardeningRetryDelayMs(4)).toBe(8 * MINUTE)
    expect(hardeningRetryDelayMs(5)).toBe(16 * MINUTE)
    // Ceiling reached, and it stays there however long the host has been broken.
    expect(hardeningRetryDelayMs(6)).toBe(30 * MINUTE)
    expect(hardeningRetryDelayMs(50)).toBe(30 * MINUTE)
    expect(hardeningRetryDelayMs(5000)).toBe(30 * MINUTE)
  })

  it('allows the first attempt for a path it has never seen', () => {
    expect(mayAttemptHardening(PATH)).toBe(true)
  })

  // The #4901 condition: the env store re-hardens on the read path about twice a second.
  it('collapses a read-path poll to a single attempt in the first minute', () => {
    const attemptedAt = pollUntil(55_000, 500)

    expect(attemptedAt).toEqual([0])
  })

  it('re-probes on the documented curve rather than on every read', () => {
    // Six hours of polling every 30s: 720 reads, and only the backoff decides how many run.
    const attemptedAt = pollUntil(6 * 60 * MINUTE, 30_000)

    // 0, +1, +2, +4, +8, +16, then every 30 minutes forever.
    expect(attemptedAt.slice(0, 6).map((ms) => ms / MINUTE)).toEqual([0, 1, 3, 7, 15, 31])
    const trailingGaps = attemptedAt
      .slice(-4)
      .map((ms, index, all) => (all[index + 1]! - ms) / MINUTE)
    expect(trailingGaps.slice(0, -1)).toEqual([30, 30, 30])
  })

  // The failure this replaced: three transient failures used to disable a path until restart.
  it('never abandons a path, however long it has been failing', () => {
    pollUntil(30 * 24 * 60 * MINUTE, 15 * MINUTE)

    // A month of failures later, the very next elapsed ceiling still re-probes.
    clock += 31 * MINUTE
    expect(mayAttemptHardening(PATH)).toBe(true)
  })

  /**
   * The same latch by another route. NTP corrections, VM snapshot restores and a user changing the
   * clock all step `Date.now()` backwards; measured against the wall clock that makes the elapsed
   * time negative, so the path stayed below its delay for the whole length of the step — a year,
   * here — which is exactly the permanent abandonment the backoff exists to remove.
   */
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

  /**
   * The state every other test here configures away: a module instance nobody has called
   * `configureHardeningRetryBudget` on, which is what a second importer gets. It used to throw,
   * and from the async lane that throw is an unhandled rejection rather than a caught error, so
   * "the budget is unconfigured" surfaced as a dead main process. Nothing is imported here but
   * the module itself — importing `secure-file.ts` is what used to hide this.
   */
  it('defaults its bounds when nothing configured it', async () => {
    vi.resetModules()
    const budget = await import('./secure-path-hardening-retry-budget.js')

    expect(budget.mayAttemptHardening(PATH)).toBe(true)
    expect(() => budget.recordHardeningOutcome(PATH, false)).not.toThrow()
    // Proof it recorded into a real cache rather than merely not throwing.
    expect(budget.mayAttemptHardening(PATH)).toBe(false)
    expect(budget.mayAttemptHardening(OTHER)).toBe(true)
  })
})

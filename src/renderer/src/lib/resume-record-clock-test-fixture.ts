import { afterEach, beforeEach, vi } from 'vitest'

/**
 * Wall-clock instant these suites run at.
 *
 * Fixtures across the resume suites date records from epoch 0 — `capturedAt: 1`,
 * `capturedAt: 2`, and so on — because they only ever needed relative ordering.
 * `isInvalidWorktreeActivationRecord` now also bounds a record's absolute age,
 * which reads those fixtures as decades old and retires every one of them.
 *
 * Pinning the clock a little past the largest fixture timestamp keeps each test
 * asserting the behaviour it was written for, and makes the age bound something
 * a test opts into by choosing a `capturedAt` far enough back.
 */
export const RESUME_RECORD_TEST_NOW = 4_000_000

/** Call at module scope in any suite that drives resume-record validity. */
export function pinResumeRecordClock(now: number = RESUME_RECORD_TEST_NOW): void {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(now)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })
}

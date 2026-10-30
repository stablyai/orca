import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS,
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from './source-control/commit/commit-failure-summary'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('commit failure summary', () => {
  it('summarizes newline-heavy commit output without splitting the full log', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const raw = `${'npm notice noisy line\n'.repeat(1000)}husky - pre-commit hook\noxlint failed`

    expect(summarizeCommitFailure(raw)).toBe('Lint failed during commit.')
    expect(split).not.toHaveBeenCalled()
  })

  it('bounds summary analysis for pathological single-line logs', () => {
    const split = vi.spyOn(String.prototype, 'split')
    const raw = 'x'.repeat(COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS + 10_000)

    expect(summarizeCommitFailure(raw)).toBe('x'.repeat(COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS))
    expect(hasExpandedCommitFailureDetails(raw, 'Commit failed.')).toBe(true)
    expect(split).not.toHaveBeenCalled()
  })
})

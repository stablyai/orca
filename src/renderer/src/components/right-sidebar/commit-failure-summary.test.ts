import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  COMMIT_FAILURE_SUMMARY_SCAN_CODE_UNITS,
  hasExpandedCommitFailureDetails,
  summarizeCommitFailure
} from './commit-failure-summary'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('commit failure summary', () => {
  it('collapses lint-staged, husky, and oxlint failures to a lint summary', () => {
    const raw = [
      'npm warn Unknown env config "python". This will stop working.',
      'husky - pre-commit hook exited with code 1',
      'lint-staged failed',
      'oxlint found 3 errors'
    ].join('\n')

    expect(summarizeCommitFailure(raw)).toBe('Lint failed during commit.')
  })

  it('collapses pre-commit hook failures without lint output to a hook summary', () => {
    expect(summarizeCommitFailure('pre-commit hook failed: secret scan blocked commit')).toBe(
      'Pre-commit hook failed.'
    )
  })

  it('does not treat generic non-lint error counts as lint failures', () => {
    expect(summarizeCommitFailure('tsc --noEmit\nFound 5 errors in 3 files.')).toBe('tsc --noEmit')
    expect(summarizeCommitFailure('pre-commit hook failed\ntsc found 5 errors')).toBe(
      'Pre-commit hook failed.'
    )
  })

  it('falls back to the first meaningful line for generic failures', () => {
    expect(summarizeCommitFailure('\n fatal: unable to auto-detect email address\nmore')).toBe(
      'fatal: unable to auto-detect email address'
    )
  })

  it('strips ANSI/control sequences and handles empty input', () => {
    expect(summarizeCommitFailure('\u001b[31meslint found 2 errors\u001b[0m')).toBe(
      'Lint failed during commit.'
    )
    expect(summarizeCommitFailure(' \n\t ')).toBe('Commit failed.')
  })

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

  it('reports whether expanded details add information beyond the summary', () => {
    expect(hasExpandedCommitFailureDetails('nothing to commit', 'nothing to commit')).toBe(false)
    expect(
      hasExpandedCommitFailureDetails(
        'husky - pre-commit hook\neslint found 2 errors\nfull output',
        'Lint failed during commit.'
      )
    ).toBe(true)
    expect(hasExpandedCommitFailureDetails('', 'Commit failed.')).toBe(false)
  })

  it('compares expanded details without whitespace regex replacement', () => {
    const replace = vi.spyOn(String.prototype, 'replace')
    const raw = ['nothing', String.fromCharCode(160), '  to\tcommit\n'].join('')

    expect(hasExpandedCommitFailureDetails(raw, 'nothing to commit')).toBe(false)
    expect(
      replace.mock.calls.filter(
        ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
      )
    ).toHaveLength(0)
  })
})

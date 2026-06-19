import { describe, expect, it } from 'vitest'
import { hasExpandedCommitFailureDetails, summarizeCommitFailure } from './commit-failure-summary'

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
})

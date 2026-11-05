// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { PR_CHECK_LOG_TAIL_EARLIER_SEPARATOR as separator } from '../../../../../../shared/source-control/checks/logs/check-job-log-tail-slice'
import { findInitialCheckLogDiagnostic } from './check-log-initial-diagnostic-position'

describe('synthetic diagnostic excerpts', () => {
  it('keeps an inline diagnostic with stack context ahead of a later standalone error', () => {
    const text = '[worker] failed TypeError: invalid argument\n at worker.ts:3:4\nError: later'
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe('TypeError: invalid argument')
    expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(
      ' at worker.ts:3:4'
    )
  })

  it('does not borrow a diagnostic or its frame from across the omission boundary', () => {
    const text = `[worker] caught Error: expected\n${separator}\nError: failed to open database at database.ts:4:5\n at real.ts:8:9`
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe(
      'Error: failed to open database at database.ts:4:5'
    )
    expect(anchor && text.slice(anchor.nearbyStackStart, anchor.nearbyStackEnd)).toBe(
      ' at real.ts:8:9'
    )
    const fallback = findInitialCheckLogDiagnostic(
      `[worker] caught Error: expected\n${separator}\n at real.ts:8:9`
    )
    expect(fallback?.nearbyStackStart).toBeUndefined()
  })

  it('retains unframed inline diagnostics as the recent-segment fallback', () => {
    const text = `Error: earlier failure\n${separator}\n[worker] failed EACCES: open database\n##[error]Process completed with exit code 1`
    const anchor = findInitialCheckLogDiagnostic(text)
    expect(anchor && text.slice(anchor.start, anchor.end)).toBe('EACCES: open database')
  })
})

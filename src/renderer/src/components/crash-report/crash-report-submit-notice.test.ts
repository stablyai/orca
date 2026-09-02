import { describe, expect, it } from 'vitest'
import {
  getCrashReportCopySubmissionFailure,
  getCrashReportSubmitFailureNotice,
  getCrashReportSubmitWarningNotice
} from './crash-report-submit-notice'

describe('crash report submit notices', () => {
  it('builds an allow-listed copy context with the exact sanitized failure reasons', () => {
    expect(
      getCrashReportCopySubmissionFailure({
        error: 'request failed at C:\\Users\\alice\\Orca',
        diagnosticBundle: {
          status: 'not_uploaded',
          reason: 'attachment timeout token=super-secret-value'
        }
      })
    ).toEqual({
      error: 'request failed at [redacted-path]',
      diagnosticContext: {
        status: 'not_uploaded',
        reason: 'attachment timeout token=[redacted]'
      }
    })
  })

  it('keeps the returned error and points attached-log failures to the no-log retry', () => {
    const notice = getCrashReportSubmitFailureNotice({ error: 'status 413' }, true)

    expect(notice).toEqual({
      title: "Crash report wasn't sent",
      description:
        'status 413. Uncheck "Attach recent diagnostic logs" and try again, or copy the details.',
      actionLabel: 'Copy Details'
    })
  })

  it('uses connection guidance when diagnostic logs were already excluded', () => {
    const notice = getCrashReportSubmitFailureNotice({ error: 'network unreachable' }, false)

    expect(notice.description).toBe(
      'network unreachable. Check your connection and try again, or copy the details.'
    )
    expect(notice.description).not.toContain('Uncheck')
  })

  it('preserves an uploaded diagnostic ticket alongside the core failure', () => {
    const notice = getCrashReportSubmitFailureNotice(
      {
        error: 'status 502',
        diagnosticBundle: {
          status: 'uploaded',
          ticketId: 'ticket-123',
          bundleSubmissionId: 'bundle-123',
          bytes: 42,
          spanCount: 2
        }
      },
      true
    )

    expect(notice.description).toContain('status 502.')
    expect(notice.description).toContain(
      'Diagnostic ticket ticket-123 was uploaded but not linked.'
    )
  })

  it('shows both failures when the attachment was already omitted', () => {
    const notice = getCrashReportSubmitFailureNotice(
      {
        error: 'fallback host unreachable',
        diagnosticBundle: {
          status: 'not_uploaded',
          reason: 'diagnostic log attachment failed: request timed out after 60 seconds'
        }
      },
      true
    )

    expect(notice.description).toContain('fallback host unreachable.')
    expect(notice.description).toContain(
      'Diagnostic logs were not attached: diagnostic log attachment failed: request timed out after 60 seconds.'
    )
    expect(notice.description).toContain('Check your connection')
    expect(notice.description).not.toContain('Uncheck')
  })

  it('safely surfaces Error messages and ignores unhelpful rejected values', () => {
    expect(
      getCrashReportSubmitFailureNotice({ error: new Error('IPC channel closed') }, false)
        .description
    ).toContain('IPC channel closed.')
    expect(
      getCrashReportSubmitFailureNotice({ error: { unexpected: true } }, false).description
    ).toContain('The crash report request failed before it returned a reason.')
  })

  it('redacts paths and tokens before displaying transport errors', () => {
    const token = `ghp_${'a'.repeat(30)}`
    const notice = getCrashReportSubmitFailureNotice(
      {
        error: `request failed at C:\\Users\\alice\\Orca\\crash-reports.json token=${token}`
      },
      false
    )

    expect(notice.description).not.toContain('alice')
    expect(notice.description).not.toContain(token)
    expect(notice.description).toContain('[redacted')
  })

  it('warns only when an opted-in diagnostic bundle was not attached', () => {
    const result = {
      ok: true as const,
      report: null,
      diagnosticBundle: {
        status: 'not_uploaded' as const,
        reason: 'bundle collection failed'
      }
    }

    expect(getCrashReportSubmitWarningNotice(result, true)).toEqual({
      title: 'Crash report sent without diagnostic logs',
      description: 'Diagnostic logs were not attached: bundle collection failed'
    })
    expect(getCrashReportSubmitWarningNotice(result, false)).toBeNull()
  })
})

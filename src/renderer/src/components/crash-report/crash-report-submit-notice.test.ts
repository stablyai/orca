import { describe, expect, it } from 'vitest'
import {
  getCrashReportCopySubmissionFailure,
  getCrashReportSubmitFailureNotice
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
})

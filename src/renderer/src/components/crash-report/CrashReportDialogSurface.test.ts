import { describe, expect, it } from 'vitest'

import {
  formatCrashReportSubmitFailureToastMessage,
  formatCrashReportSubmitSuccessToastMessage
} from './CrashReportDialogSurface'

describe('formatCrashReportSubmitFailureToastMessage', () => {
  it('formats status codes without exposing raw failure text', () => {
    const message = formatCrashReportSubmitFailureToastMessage({
      status: 413,
      error: 'status 413\n/Users/alice/project/token=abc123'
    })

    expect(message).toBe('Failed to send crash report. Status 413.')
    expect(message).not.toContain('/Users/alice')
    expect(message).not.toContain('token=abc123')
  })

  it('adds log guidance for omitted attachment retries and sanitizes timeout text', () => {
    const message = formatCrashReportSubmitFailureToastMessage({
      status: null,
      error: 'request aborted after /Users/alice/project',
      diagnosticBundle: {
        status: 'not_uploaded',
        reason: 'diagnostic log attachment submit failed; logs were not uploaded'
      }
    })

    expect(message).toBe(
      'Failed to send crash report. Timed out. Diagnostic logs were not uploaded because the attachment submit failed.'
    )
    expect(message).not.toContain('/Users/alice')
  })

  it('labels network failures without leaking raw exceptions', () => {
    const message = formatCrashReportSubmitFailureToastMessage({
      status: null,
      error: 'fetch failed: /Users/alice/project token=abc123'
    })

    expect(message).toBe('Failed to send crash report. Network error.')
    expect(message).not.toContain('/Users/alice')
    expect(message).not.toContain('token=abc123')
  })

  it('labels successful no-log retries', () => {
    expect(
      formatCrashReportSubmitSuccessToastMessage({
        status: 'not_uploaded',
        reason: 'diagnostic log attachment submit failed; logs were not uploaded'
      })
    ).toBe('Crash report sent without diagnostic logs.')
    expect(formatCrashReportSubmitSuccessToastMessage()).toBe('Crash report sent.')
  })
})

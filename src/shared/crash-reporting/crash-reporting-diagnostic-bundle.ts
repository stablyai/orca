export type CrashReportDiagnosticBundle =
  | {
      status: 'attached'
      bundleSubmissionId: string
      bytes: number
      spanCount: number
    }
  | {
      status: 'uploaded'
      ticketId: string
      bundleSubmissionId: string
      bytes: number
      spanCount: number
    }
  | {
      status: 'not_uploaded'
      reason: string
      bundleSubmissionId?: string
      bytes?: number
      spanCount?: number
    }

export function appendDiagnosticBundleLines(
  lines: string[],
  diagnosticBundle: CrashReportDiagnosticBundle | undefined,
  sanitizeString: (value: string) => string
): void {
  if (!diagnosticBundle) {
    return
  }
  lines.push('', 'Diagnostic log:')
  if (diagnosticBundle.status === 'attached') {
    lines.push(
      '- Status: attached',
      `- Bundle submission ID: ${sanitizeString(diagnosticBundle.bundleSubmissionId)}`,
      `- Spans: ${diagnosticBundle.spanCount}`,
      `- Bytes: ${diagnosticBundle.bytes}`
    )
    return
  }
  if (diagnosticBundle.status === 'uploaded') {
    lines.push(
      '- Status: uploaded',
      `- Ticket ID: ${sanitizeString(diagnosticBundle.ticketId)}`,
      `- Bundle submission ID: ${sanitizeString(diagnosticBundle.bundleSubmissionId)}`,
      `- Spans: ${diagnosticBundle.spanCount}`,
      `- Bytes: ${diagnosticBundle.bytes}`
    )
    return
  }
  lines.push('- Status: not uploaded', `- Reason: ${sanitizeString(diagnosticBundle.reason)}`)
  if (diagnosticBundle.bundleSubmissionId) {
    lines.push(`- Bundle submission ID: ${sanitizeString(diagnosticBundle.bundleSubmissionId)}`)
  }
  if (typeof diagnosticBundle.spanCount === 'number') {
    lines.push(`- Spans: ${diagnosticBundle.spanCount}`)
  }
  if (typeof diagnosticBundle.bytes === 'number') {
    lines.push(`- Bytes: ${diagnosticBundle.bytes}`)
  }
}

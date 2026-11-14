import { translate } from '@/i18n/i18n'
import {
  sanitizeCrashReportString,
  type CrashReportCopySubmissionFailure,
  type CrashReportDiagnosticBundle,
  type CrashReportSubmitResult
} from '../../../../shared/crash-reporting'

export const CRASH_REPORT_SUBMIT_FAILURE_TOAST_ID = 'crash-report-submit-failure'

export type CrashReportSubmitFailureNotice = {
  title: string
  description: string
  actionLabel: string
}

export type CrashReportSubmitWarningNotice = {
  title: string
  description: string
}

type CrashReportSubmitFailureLike = {
  error: unknown
  diagnosticBundle?: CrashReportDiagnosticBundle
}

function normalizedFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const sanitized = sanitizeCrashReportString(message).trim()
  return (
    sanitized ||
    translate(
      'auto.components.crash.report.submit.notice.unknownError',
      'The crash report request failed before it returned a reason.'
    )
  )
}

function asSentence(message: string): string {
  return /[.!?]$/.test(message) ? message : `${message}.`
}

export function getCrashReportCopySubmissionFailure(
  failure: CrashReportSubmitFailureLike
): CrashReportCopySubmissionFailure {
  const diagnosticContext =
    failure.diagnosticBundle?.status === 'uploaded'
      ? {
          status: 'uploaded' as const,
          ticketId: sanitizeCrashReportString(failure.diagnosticBundle.ticketId)
        }
      : failure.diagnosticBundle?.status === 'not_uploaded'
        ? {
            status: 'not_uploaded' as const,
            reason: normalizedFailureMessage(failure.diagnosticBundle.reason)
          }
        : undefined
  return {
    error: normalizedFailureMessage(failure.error),
    ...(diagnosticContext ? { diagnosticContext } : {})
  }
}

export function getCrashReportSubmitFailureNotice(
  failure: CrashReportSubmitFailureLike,
  includeDiagnosticLogs: boolean,
  isFreezeReport = false
): CrashReportSubmitFailureNotice {
  const ticketDetail =
    failure.diagnosticBundle?.status === 'uploaded'
      ? translate(
          'auto.components.crash.report.submit.notice.ticketUploaded',
          'Diagnostic ticket {{value0}} was uploaded but not linked.',
          { value0: sanitizeCrashReportString(failure.diagnosticBundle.ticketId) }
        )
      : null
  const omittedDetail =
    failure.diagnosticBundle?.status === 'not_uploaded'
      ? asSentence(
          isFreezeReport
            ? translate(
                'crashReport.freeze.attachmentsOmitted',
                'The saved freeze report and diagnostic logs were not attached: {{value0}}',
                { value0: normalizedFailureMessage(failure.diagnosticBundle.reason) }
              )
            : translate(
                'auto.components.crash.report.submit.notice.diagnosticsReason',
                'Diagnostic logs were not attached: {{value0}}',
                { value0: normalizedFailureMessage(failure.diagnosticBundle.reason) }
              )
        )
      : null
  const attachmentAlreadyOmitted = failure.diagnosticBundle?.status === 'not_uploaded'
  const recovery =
    includeDiagnosticLogs && !attachmentAlreadyOmitted
      ? isFreezeReport
        ? translate(
            'crashReport.freeze.uncheckAttachments',
            'Uncheck "Attach saved freeze report and diagnostic logs" and try again, or copy the details.'
          )
        : translate(
            'auto.components.crash.report.submit.notice.uncheckDiagnostics',
            'Uncheck "Attach recent diagnostic logs" and try again, or copy the details.'
          )
      : translate(
          'auto.components.crash.report.submit.notice.checkConnection',
          'Check your connection and try again, or copy the details.'
        )

  return {
    title: isFreezeReport
      ? translate('crashReport.freeze.notSent', "Freeze report wasn't sent")
      : translate('auto.components.crash.report.submit.notice.notSent', "Crash report wasn't sent"),
    description: [
      asSentence(normalizedFailureMessage(failure.error)),
      ticketDetail,
      omittedDetail,
      recovery
    ]
      .filter((part): part is string => Boolean(part))
      .join(' '),
    actionLabel: translate('auto.components.crash.report.submit.notice.copyDetails', 'Copy Details')
  }
}

export function getCrashReportSubmitWarningNotice(
  result: Extract<CrashReportSubmitResult, { ok: true }>,
  includeDiagnosticLogs: boolean,
  isFreezeReport = false
): CrashReportSubmitWarningNotice | null {
  if (!includeDiagnosticLogs || result.diagnosticBundle?.status !== 'not_uploaded') {
    return null
  }

  return {
    title: isFreezeReport
      ? translate(
          'crashReport.freeze.sentWithoutAttachments',
          'Details sent without the saved freeze report or diagnostic logs'
        )
      : translate(
          'auto.components.crash.report.submit.notice.sentWithoutDiagnostics',
          'Crash report sent without diagnostic logs'
        ),
    description: isFreezeReport
      ? translate(
          'crashReport.freeze.attachmentsOmitted',
          'The saved freeze report and diagnostic logs were not attached: {{value0}}',
          { value0: normalizedFailureMessage(result.diagnosticBundle.reason) }
        )
      : translate(
          'auto.components.crash.report.submit.notice.diagnosticsReason',
          'Diagnostic logs were not attached: {{value0}}',
          { value0: normalizedFailureMessage(result.diagnosticBundle.reason) }
        )
  }
}

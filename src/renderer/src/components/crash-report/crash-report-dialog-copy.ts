import {
  isReactErrorBoundaryReport,
  type CrashReportRecord
} from '../../../../shared/crash-reporting'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'

export function formatSummary(report: CrashReportRecord, t: Translate = translate): string {
  if (report.reason === 'main-thread-hang') {
    return t('crashReport.freeze.summary', 'Orca stopped responding')
  }
  if (isReactErrorBoundaryReport(report)) {
    const surface = typeof report.details.surface === 'string' ? report.details.surface : null
    return surface
      ? t(
          'auto.components.crash.report.CrashReportDialogSurface.renderErrorIn',
          'React render error in {{surface}}',
          { surface }
        )
      : t('auto.components.crash.report.CrashReportDialogSurface.renderError', 'React render error')
  }
  return `${report.processType} ${report.reason}${
    report.exitCode === null ? '' : ` (exit ${report.exitCode})`
  }`
}

export function getDialogTitle(report: CrashReportRecord | null, t: Translate = translate): string {
  if (report?.reason === 'main-thread-hang') {
    return t('crashReport.freeze.title', 'Report a freeze')
  }
  if (!report) {
    return t('auto.components.crash.report.CrashReportDialogSurface.reportTitle', 'Report a crash')
  }
  return report && isReactErrorBoundaryReport(report)
    ? t(
        'auto.components.crash.report.CrashReportDialogSurface.uiErrorTitle',
        'Orca hit a recoverable UI error'
      )
    : t(
        'auto.components.crash.report.CrashReportDialogSurface.closedTitle',
        'Orca closed unexpectedly'
      )
}

export function getDialogDescription(
  report: CrashReportRecord | null,
  t: Translate = translate
): string {
  if (report?.reason === 'main-thread-hang') {
    return t(
      'crashReport.freeze.description',
      'Send the saved freeze report to help us understand what happened.'
    )
  }
  if (!report) {
    return t(
      'auto.components.crash.report.CrashReportDialogSurface.reportDescription',
      'Send a privacy-safe crash report. Recent redacted diagnostic logs are included when available.'
    )
  }
  return report && isReactErrorBoundaryReport(report)
    ? t(
        'auto.components.crash.report.CrashReportDialogSurface.uiErrorDescription',
        'Send a privacy-safe diagnostic report to help us understand the failed UI surface.'
      )
    : t(
        'auto.components.crash.report.CrashReportDialogSurface.closedDescription',
        'Send a privacy-safe diagnostic report to help us understand what happened.'
      )
}

export function getNotesPlaceholder(
  report: CrashReportRecord | null,
  t: Translate = translate
): string {
  if (report?.reason === 'main-thread-hang') {
    return t('crashReport.freeze.notes', 'Optional: what were you doing before Orca froze?')
  }
  if (!report) {
    return t(
      'auto.components.crash.report.CrashReportDialogSurface.reportNotesPlaceholder',
      'Optional: what happened?'
    )
  }
  return report && isReactErrorBoundaryReport(report)
    ? t(
        'auto.components.crash.report.CrashReportDialogSurface.uiErrorNotesPlaceholder',
        'Optional: what were you doing before this UI error?'
      )
    : t(
        'auto.components.crash.report.CrashReportDialogSurface.closedNotesPlaceholder',
        'Optional: what were you doing before Orca closed?'
      )
}

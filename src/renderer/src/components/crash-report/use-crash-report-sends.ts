import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  CrashReportRecord,
  CrashReportSubmitArgs,
  CrashReportSubmitResult
} from '../../../../shared/crash-reporting'
import {
  CRASH_REPORT_SUBMIT_FAILURE_TOAST_ID,
  getCrashReportSubmitWarningNotice
} from './crash-report-submit-notice'

export type CrashReportSendRequest = Omit<CrashReportSubmitArgs, 'reportId'>

/** The send key of a dialog opened from Help with no captured report. */
const NO_REPORT = ''

/**
 * Crash report sends, owned by the dialog's owner and keyed by report id, so a send's result
 * settles its report even when the dialog that started it was replaced or closed meanwhile, and a
 * report already being sent can never be sent again.
 */
export function useCrashReportSends(
  onSent: (reportId: string | null, sent: CrashReportRecord | null) => void
): {
  send: (
    report: CrashReportRecord | null,
    request: CrashReportSendRequest
  ) => Promise<CrashReportSubmitResult>
  isSending: (report: CrashReportRecord | null) => boolean
} {
  const [sending, setSending] = useState<ReadonlySet<string>>(() => new Set())

  const send = useCallback(
    async (
      report: CrashReportRecord | null,
      request: CrashReportSendRequest
    ): Promise<CrashReportSubmitResult> => {
      const key = report?.id ?? NO_REPORT
      setSending((current) => new Set(current).add(key))
      try {
        const result = await window.api.crashReports.submit({
          ...(report ? { reportId: report.id } : {}),
          ...request
        })
        if (result.ok) {
          onSent(report?.id ?? null, result.report)
          toast.dismiss(CRASH_REPORT_SUBMIT_FAILURE_TOAST_ID)
          const warningNotice = getCrashReportSubmitWarningNotice(
            result,
            request.includeDiagnosticLogs === true
          )
          if (warningNotice) {
            toast.warning(warningNotice.title, { description: warningNotice.description })
          } else {
            toast.success(
              translate(
                'auto.components.crash.report.CrashReportDialog.8e24fe4f75',
                'Crash report sent.'
              )
            )
          }
        }
        return result
      } finally {
        setSending((current) => {
          const next = new Set(current)
          next.delete(key)
          return next
        })
      }
    },
    [onSent]
  )

  const isSending = useCallback(
    (report: CrashReportRecord | null) => sending.has(report?.id ?? NO_REPORT),
    [sending]
  )
  return { send, isSending }
}

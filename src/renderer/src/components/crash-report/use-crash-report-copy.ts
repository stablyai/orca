import { useCallback, useRef } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type {
  CrashReportCopySubmissionFailure,
  CrashReportRecord
} from '../../../../shared/crash-reporting'

export const CRASH_REPORT_COPY_FAILURE_TOAST_ID = 'crash-report-copy-failure'

function showCopyFailure(description?: string): void {
  toast.error(
    translate(
      'auto.components.crash.report.copy.copyFailed',
      'Crash report details could not be copied.'
    ),
    {
      id: CRASH_REPORT_COPY_FAILURE_TOAST_ID,
      ...(description ? { description } : {}),
      duration: Infinity,
      dismissible: true
    }
  )
}

export function useCrashReportCopy(
  report: CrashReportRecord | null,
  notes: string
): (submissionFailure?: CrashReportCopySubmissionFailure) => Promise<void> {
  const reportId = report?.id ?? null
  const notesRef = useRef({ reportId, value: notes })
  // Toasts outlive their render; track current notes under the report they belong to.
  if (notesRef.current.reportId === reportId) {
    notesRef.current.value = notes
  } else {
    notesRef.current = { reportId, value: notes }
  }
  const reportNotes = notesRef.current

  return useCallback(
    async (submissionFailure?: CrashReportCopySubmissionFailure): Promise<void> => {
      try {
        const result = await window.api.crashReports.copyLatestDiagnostics({
          ...(report ? { reportId: report.id } : {}),
          notes: reportNotes.value,
          ...(submissionFailure ? { submissionFailure } : {})
        })
        if (!result.ok) {
          showCopyFailure(result.error)
          return
        }
        toast.dismiss(CRASH_REPORT_COPY_FAILURE_TOAST_ID)
        toast.success(
          translate(
            'auto.components.crash.report.CrashReportDialog.8b8473c544',
            'Crash report copied.'
          )
        )
      } catch (error) {
        console.error('Failed to copy crash report details:', error)
        // Sonner dismisses clicked action toasts; replace with a sticky recovery action without raw IPC details.
        showCopyFailure()
      }
    },
    [report, reportNotes]
  )
}

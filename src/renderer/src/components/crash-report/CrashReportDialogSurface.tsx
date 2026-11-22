import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { DialogCancel, DialogDisclosure } from '@/components/ui/dialog-parts'
import { Label } from '@/components/ui/label'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  formatCrashReportText,
  MAX_USER_NOTES_LENGTH,
  type CrashReportRecord
} from '../../../../shared/crash-reporting/crash-reporting'
import type { CrashReportDiagnosticBundle } from '../../../../shared/crash-reporting/crash-reporting-diagnostic-bundle'
import type { GitHubViewer } from '../../../../shared/github/pull-requests/pull-request-types'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import {
  CRASH_REPORT_SUBMIT_FAILURE_TOAST_ID,
  getCrashReportCopySubmissionFailure,
  getCrashReportSubmitFailureNotice,
  getCrashReportSubmitWarningNotice
} from './crash-report-submit-notice'
import { useCrashReportCopy } from './use-crash-report-copy'
import {
  formatSummary,
  getDialogTitle,
  getDialogDescription,
  getNotesPlaceholder
} from './crash-report-dialog-copy'

type CrashReportDialogSurfaceProps = {
  open: boolean
  report: CrashReportRecord | null
  loading: boolean
  onOpenChange: (open: boolean) => void
  onReportChange: (report: CrashReportRecord | null) => void
}

export function CrashReportDialogSurface({
  open,
  report,
  loading,
  onOpenChange,
  onReportChange
}: CrashReportDialogSurfaceProps): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const mountedRef = useMountedRef()
  const [notes, setNotes] = useState('')
  const [includeDiagnosticLogs, setIncludeDiagnosticLogs] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [viewer, setViewer] = useState<GitHubViewer | null>(null)
  // Sequence viewer lookups so late close/reopen results cannot supply a stale submission identity.
  const viewerRequestIdRef = useRef(0)
  const deferredNotes = useDeferredValue(notes)
  const diagnosticText = useMemo(
    // Defer full-payload redaction/truncation so notes typing stays responsive.
    () => (report ? formatCrashReportText(report, deferredNotes) : ''),
    [deferredNotes, report]
  )
  const copyCrashReportDetails = useCrashReportCopy(report, notes)
  const isFreezeReport = report?.reason === 'main-thread-hang'

  const clearViewer = useCallback((): void => {
    viewerRequestIdRef.current += 1
    setViewer(null)
  }, [])

  const loadViewerForOpenDialog = useCallback((): void => {
    const requestId = ++viewerRequestIdRef.current
    setViewer(null)
    void window.api.gh
      .viewer()
      .then((nextViewer) => {
        if (mountedRef.current && requestId === viewerRequestIdRef.current) {
          setViewer(nextViewer)
        }
      })
      .catch((error) => {
        if (mountedRef.current && requestId === viewerRequestIdRef.current) {
          setViewer(null)
          console.error('Failed to load GitHub viewer for crash report:', error)
        }
      })
  }, [mountedRef])

  useEffect(() => {
    if (!open) {
      clearViewer()
      return
    }
    setIncludeDiagnosticLogs(true)
    loadViewerForOpenDialog()
  }, [clearViewer, loadViewerForOpenDialog, open])

  const showSubmitFailure = (
    error: unknown,
    diagnosticBundle?: CrashReportDiagnosticBundle
  ): void => {
    const failure = { error, ...(diagnosticBundle ? { diagnosticBundle } : {}) }
    const notice = getCrashReportSubmitFailureNotice(failure, includeDiagnosticLogs, isFreezeReport)
    const copyFailure = getCrashReportCopySubmissionFailure(failure)
    toast.error(notice.title, {
      id: CRASH_REPORT_SUBMIT_FAILURE_TOAST_ID,
      description: notice.description,
      duration: Infinity,
      dismissible: true,
      action: {
        label: notice.actionLabel,
        onClick: () => {
          void copyCrashReportDetails(copyFailure)
        }
      }
    })
  }

  const dismissReportIfNeeded = async (): Promise<void> => {
    if (report?.status === 'pending') {
      await window.api.crashReports.dismiss({ reportId: report.id })
      if (mountedRef.current) {
        onReportChange({ ...report, status: 'dismissed' })
      }
    }
  }

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true)
    try {
      const result = await window.api.crashReports.submit({
        ...(report ? { reportId: report.id } : {}),
        notes,
        includeDiagnosticLogs,
        // Identity lookup is best-effort; allow anonymous reports when gh is unavailable.
        submitAnonymously: !viewer,
        githubLogin: viewer?.login ?? null,
        githubEmail: null
      })
      if (!result.ok) {
        showSubmitFailure(result.error, result.diagnosticBundle)
        console.error('Failed to submit crash report:', result.error)
        return
      }
      if (!mountedRef.current) {
        return
      }
      onReportChange(result.report)
      setNotes('')
      toast.dismiss(CRASH_REPORT_SUBMIT_FAILURE_TOAST_ID)
      const warningNotice = getCrashReportSubmitWarningNotice(
        result,
        includeDiagnosticLogs,
        isFreezeReport
      )
      if (warningNotice) {
        toast.warning(warningNotice.title, { description: warningNotice.description })
      } else {
        toast.success(
          isFreezeReport
            ? t('crashReport.freeze.sent', 'Freeze report sent.')
            : t('auto.components.crash.report.CrashReportDialog.8e24fe4f75', 'Crash report sent.')
        )
      }
      onOpenChange(false)
    } catch (error) {
      showSubmitFailure(error)
      console.error('Failed to submit crash report:', error)
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (submitting && !nextOpen) {
          return
        }
        if (!nextOpen) {
          clearViewer()
          void dismissReportIfNeeded().finally(() => {
            if (mountedRef.current) {
              onOpenChange(false)
            }
          })
          return
        }
        onOpenChange(true)
      }}
    >
      <DialogContent size="form" busy={submitting}>
        <DialogHeader>
          <DialogTitle>{getDialogTitle(report, t)}</DialogTitle>
          <DialogDescription>{getDialogDescription(report, t)}</DialogDescription>
        </DialogHeader>

        {report ? null : (
          <p className="text-[13px] text-muted-foreground">
            {loading
              ? t(
                  'auto.components.crash.report.CrashReportDialog.765591798d',
                  'Checking for crash reports...'
                )
              : t(
                  'auto.components.crash.report.CrashReportDialog.ead6fc0510',
                  'No automatic crash report was captured. You can still send details and include recent diagnostic logs when available.'
                )}
          </p>
        )}
        <div className="grid gap-1">
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={3}
            // Keep the UI and formatter on the same input budget.
            maxLength={MAX_USER_NOTES_LENGTH}
            aria-label={getNotesPlaceholder(report, t)}
            placeholder={getNotesPlaceholder(report, t)}
            className="min-h-16 w-full rounded-md border border-input bg-background px-3 py-2 text-[13px] outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          {/* Why only near the limit: the count matters once typing can be cut off. */}
          {notes.length > MAX_USER_NOTES_LENGTH * 0.8 ? (
            <div
              aria-hidden="true"
              className="text-right text-xs tabular-nums text-muted-foreground"
            >
              {notes.length.toLocaleString(intlLocale)} /{' '}
              {MAX_USER_NOTES_LENGTH.toLocaleString(intlLocale)}
            </div>
          ) : null}
        </div>
        <div className="flex items-start gap-2">
          <Checkbox
            id="crash-report-attach-diagnostics"
            checked={includeDiagnosticLogs}
            onCheckedChange={(checked) => setIncludeDiagnosticLogs(checked === true)}
            disabled={submitting}
            className="mt-0.5"
          />
          <Label htmlFor="crash-report-attach-diagnostics" variant="dialog">
            {isFreezeReport
              ? t(
                  'crashReport.freeze.includeRedacted',
                  'Include the saved freeze report and recent logs (redacted)'
                )
              : t('crashReport.includeRecentLogsRedacted', 'Include recent logs (redacted)')}
          </Label>
        </div>
        {report ? (
          <DialogDisclosure label={t('crashReport.details', 'Details')} variant="code">
            <div className="text-foreground">{formatSummary(report, t)}</div>
            <div>
              {new Date(
                isFreezeReport && typeof report.details.detectedAt === 'string'
                  ? report.details.detectedAt
                  : report.createdAt
              ).toLocaleString(intlLocale)}{' '}
              · {report.platform} {report.arch} ·{' '}
              {t('auto.components.crash.report.CrashReportDialog.835037edc9', 'Orca')}{' '}
              {report.appVersion}
            </div>
            <pre className="mt-1.5 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {diagnosticText}
            </pre>
          </DialogDisclosure>
        ) : null}

        <DialogFooter
          start={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void copyCrashReportDetails()}
              disabled={loading}
            >
              {t('crashReport.copyDetails', 'Copy details')}
            </Button>
          }
        >
          <DialogCancel>{t('crashReport.dontSend', 'Don’t send')}</DialogCancel>
          <Button type="button" size="sm" onClick={handleSubmit} disabled={loading || submitting}>
            {submitting
              ? t('crashReport.sending', 'Sending…')
              : t('crashReport.sendReport', 'Send report')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Clipboard, Send } from 'lucide-react'
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
import { Label } from '@/components/ui/label'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  formatCrashReportText,
  isReactErrorBoundaryReport,
  type CrashReportRecord
} from '../../../../shared/crash-reporting'
import type { GitHubViewer } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'

function formatSummary(report: CrashReportRecord): string {
  if (isReactErrorBoundaryReport(report)) {
    const surface = typeof report.details.surface === 'string' ? report.details.surface : null
    return surface ? `React render error in ${surface}` : 'React render error'
  }
  return `${report.processType} ${report.reason}${
    report.exitCode === null ? '' : ` (exit ${report.exitCode})`
  }`
}

function getDialogTitle(report: CrashReportRecord | null): string {
  if (!report) {
    return 'Report a crash'
  }
  return report && isReactErrorBoundaryReport(report)
    ? 'Orca hit a recoverable UI error'
    : 'Orca closed unexpectedly'
}

function getDialogDescription(report: CrashReportRecord | null): string {
  if (!report) {
    return 'Send a privacy-safe crash report. Recent redacted diagnostic logs are included when available.'
  }
  return report && isReactErrorBoundaryReport(report)
    ? 'Send a privacy-safe diagnostic report to help us understand the failed UI surface.'
    : 'Send a privacy-safe diagnostic report to help us understand what happened.'
}

function getNotesPlaceholder(report: CrashReportRecord | null): string {
  if (!report) {
    return 'Optional: what happened?'
  }
  return report && isReactErrorBoundaryReport(report)
    ? 'Optional: what were you doing before this UI error?'
    : 'Optional: what were you doing before Orca closed?'
}

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
  const mountedRef = useMountedRef()
  const [notes, setNotes] = useState('')
  const [includeDiagnosticLogs, setIncludeDiagnosticLogs] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [viewer, setViewer] = useState<GitHubViewer | null>(null)
  // Why: account lookup can resolve after the dialog closes or reopens.
  // Sequence the request so a stale viewer is never used for submission.
  const viewerRequestIdRef = useRef(0)
  const deferredNotes = useDeferredValue(notes)
  const diagnosticText = useMemo(
    // Why: formatting applies redaction and truncation over the full crash
    // payload. Keep that preview update out of the textarea keystroke path.
    () => (report ? formatCrashReportText(report, deferredNotes) : ''),
    [deferredNotes, report]
  )

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

  const handleCopy = async (): Promise<void> => {
    const result = await window.api.crashReports.copyLatestDiagnostics(
      report ? { reportId: report.id, notes } : { notes }
    )
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success(
      translate('auto.components.crash.report.CrashReportDialog.8b8473c544', 'Crash report copied.')
    )
  }

  const dismissReportIfNeeded = async (): Promise<void> => {
    if (report?.status === 'pending') {
      await window.api.crashReports.dismiss({ reportId: report.id })
      if (mountedRef.current) {
        onReportChange({ ...report, status: 'dismissed' })
      }
    }
  }

  const handleDismiss = async (): Promise<void> => {
    await dismissReportIfNeeded()
    if (mountedRef.current) {
      onOpenChange(false)
    }
  }

  const handleSubmit = async (): Promise<void> => {
    setSubmitting(true)
    try {
      const result = await window.api.crashReports.submit({
        ...(report ? { reportId: report.id } : {}),
        notes,
        includeDiagnosticLogs,
        // Why: crash reporting must degrade to anonymous if gh is unavailable;
        // identity lookup is best-effort and never blocks report creation.
        submitAnonymously: !viewer,
        githubLogin: viewer?.login ?? null,
        githubEmail: null
      })
      if (!result.ok) {
        if (result.diagnosticBundle?.status === 'uploaded') {
          toast.error(
            translate(
              'auto.components.crash.report.CrashReportDialog.b2e36f53a1',
              'Failed to send crash report. Diagnostic ticket {{value0}} was uploaded but not linked.',
              { value0: result.diagnosticBundle.ticketId }
            )
          )
        } else {
          toast.error(
            translate(
              'auto.components.crash.report.CrashReportDialog.56a3dfa283',
              'Failed to send crash report.'
            )
          )
        }
        console.error('Failed to submit crash report:', result.error)
        return
      }
      if (!mountedRef.current) {
        return
      }
      onReportChange(result.report)
      setNotes('')
      toast.success(
        translate('auto.components.crash.report.CrashReportDialog.8e24fe4f75', 'Crash report sent.')
      )
      onOpenChange(false)
    } catch (error) {
      toast.error(
        translate(
          'auto.components.crash.report.CrashReportDialog.56a3dfa283',
          'Failed to send crash report.'
        )
      )
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
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="size-4 text-destructive" />
            {getDialogTitle(report)}
          </DialogTitle>
          <DialogDescription className="text-xs">{getDialogDescription(report)}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {report ? (
            <>
              <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs">
                <div className="font-medium text-foreground">{formatSummary(report)}</div>
                <div className="mt-1 text-muted-foreground">
                  {new Date(report.createdAt).toLocaleString()} · {report.platform} {report.arch} ·
                  {translate('auto.components.crash.report.CrashReportDialog.835037edc9', 'Orca')}{' '}
                  {report.appVersion}
                </div>
              </div>
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground">
                  {translate(
                    'auto.components.crash.report.CrashReportDialog.6d3ebe216a',
                    'Diagnostic text'
                  )}
                </div>
                <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/20 p-3 font-mono text-[11px] leading-5 text-muted-foreground scrollbar-sleek">
                  {diagnosticText}
                </pre>
              </div>
            </>
          ) : (
            <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
              {loading
                ? translate(
                    'auto.components.crash.report.CrashReportDialog.765591798d',
                    'Checking for crash reports...'
                  )
                : translate(
                    'auto.components.crash.report.CrashReportDialog.ead6fc0510',
                    'No automatic crash report was captured. You can still send details and include recent diagnostic logs when available.'
                  )}
            </div>
          )}
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            rows={4}
            placeholder={getNotesPlaceholder(report)}
            className="min-h-24 w-full rounded-md border border-border bg-background px-3 py-2 text-sm outline-none ring-offset-background placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          />
          <div className="flex items-start gap-2 rounded-md border border-border/70 bg-muted/20 p-3">
            <Checkbox
              id="crash-report-attach-diagnostics"
              checked={includeDiagnosticLogs}
              onCheckedChange={(checked) => setIncludeDiagnosticLogs(checked === true)}
              disabled={submitting}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor="crash-report-attach-diagnostics" className="text-xs">
                {translate(
                  'auto.components.crash.report.CrashReportDialog.b082f27490',
                  'Attach recent diagnostic logs'
                )}
              </Label>
              <div className="text-xs leading-5 text-muted-foreground">
                {translate(
                  'auto.components.crash.report.CrashReportDialog.e59f0b9427',
                  'Sends a capped redacted log bundle with the report.'
                )}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleCopy} disabled={loading}>
            <Clipboard className="size-3.5" />
            {translate('auto.components.crash.report.CrashReportDialog.50b00dc327', 'Copy Details')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            disabled={submitting}
          >
            {translate('auto.components.crash.report.CrashReportDialog.88fea8e84e', "Don't Send")}
          </Button>
          <Button type="button" size="sm" onClick={handleSubmit} disabled={loading || submitting}>
            <Send className="size-3.5" />
            {translate('auto.components.crash.report.CrashReportDialog.b4951cd27c', 'Send Report')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

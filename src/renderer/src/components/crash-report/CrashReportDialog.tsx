import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Clipboard, FileText, Send } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'
import type { DiagnosticsBundlePayload } from '../../../../preload/api-types'

function formatSummary(report: CrashReportRecord): string {
  return `${report.processType} ${report.reason}${
    report.exitCode === null ? '' : ` (exit ${report.exitCode})`
  }`
}

type BundleState =
  | { stage: 'idle' }
  | { stage: 'collecting' }
  | { stage: 'preview'; bundle: DiagnosticsBundlePayload; editedPayload: string }
  | { stage: 'uploading'; bundle: DiagnosticsBundlePayload; editedPayload: string }

export function CrashReportDialog(): React.JSX.Element {
  const promptedThisLaunch = useRef(false)
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<CrashReportRecord | null>(null)
  const [loading, setLoading] = useState(false)
  const [bundleState, setBundleState] = useState<BundleState>({ stage: 'idle' })

  const loadPendingReport = async (promptIfPresent: boolean): Promise<void> => {
    setLoading(true)
    try {
      const pending = await window.api.crashReports.getLatestPending()
      let displayedReport = pending
      if (pending && promptIfPresent) {
        try {
          // Why: startup crash prompts are one-shot. The open dialog keeps the
          // report data locally if the user chooses to send immediately.
          await window.api.crashReports.dismiss({ reportId: pending.id })
          displayedReport = { ...pending, status: 'dismissed' as const }
        } catch (error) {
          console.error('Failed to dismiss crash report after startup prompt:', error)
        }
      }
      setReport(displayedReport)
      if (pending && promptIfPresent) {
        setOpen(true)
      }
    } catch (error) {
      console.error('Failed to load crash report:', error)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (promptedThisLaunch.current) {
      return
    }
    promptedThisLaunch.current = true
    void loadPendingReport(true)
  }, [])

  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      void loadPendingReport(false).then(() => setOpen(true))
    })
  }, [])

  useEffect(() => {
    if (!open && bundleState.stage !== 'idle') {
      setBundleState({ stage: 'idle' })
    }
  }, [bundleState.stage, open])

  const handleCopy = async (): Promise<void> => {
    const result = await window.api.crashReports.copyLatestDiagnostics(
      report ? { reportId: report.id } : {}
    )
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Crash report copied.')
  }

  const dismissReportIfNeeded = async (): Promise<void> => {
    if (report?.status === 'pending') {
      await window.api.crashReports.dismiss({ reportId: report.id })
      setReport({ ...report, status: 'dismissed' })
    }
  }

  const handleDismiss = async (): Promise<void> => {
    await dismissReportIfNeeded()
    setOpen(false)
  }

  const handleCollectBundle = async (): Promise<void> => {
    if (!report) {
      return
    }
    setBundleState({ stage: 'collecting' })
    try {
      const bundle = await window.api.diagnostics.collectBundle()
      setBundleState({ stage: 'preview', bundle, editedPayload: bundle.payload })
    } catch (error) {
      setBundleState({ stage: 'idle' })
      toast.error(`Could not collect diagnostic bundle: ${(error as Error).message}`)
    }
  }

  const handleUploadBundle = async (): Promise<void> => {
    if (!report || bundleState.stage !== 'preview') {
      return
    }
    const { bundle, editedPayload } = bundleState
    setBundleState({ stage: 'uploading', bundle, editedPayload })
    try {
      await window.api.diagnostics.uploadBundle(editedPayload, bundle.bundleSubmissionId)
      try {
        const sent = await window.api.crashReports.markSent({ reportId: report.id })
        setReport(sent ?? { ...report, status: 'sent' })
      } catch (error) {
        // Why: the diagnostic upload already succeeded. A local prompt-state
        // write failure should not present as a failed send or invite re-upload.
        console.error('Failed to mark crash report sent:', error)
        setReport({ ...report, status: 'sent' })
      }
      setBundleState({ stage: 'idle' })
      toast.success('Diagnostic bundle sent.')
      setOpen(false)
    } catch (error) {
      setBundleState({ stage: 'preview', bundle, editedPayload })
      toast.error(`Could not send diagnostic bundle: ${(error as Error).message}`)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (bundleState.stage === 'uploading' && !nextOpen) {
          return
        }
        if (!nextOpen) {
          void dismissReportIfNeeded().finally(() => setOpen(false))
          return
        }
        setOpen(true)
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <AlertTriangle className="size-4 text-destructive" />
            Orca closed unexpectedly
          </DialogTitle>
          <DialogDescription className="text-xs">
            Review a diagnostic bundle before sending it to Orca support.
          </DialogDescription>
        </DialogHeader>

        {report ? (
          <div className="space-y-3">
            <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs">
              <div className="font-medium text-foreground">{formatSummary(report)}</div>
              <div className="mt-1 text-muted-foreground">
                {new Date(report.createdAt).toLocaleString()} · {report.platform} {report.arch} ·
                Orca {report.appVersion}
              </div>
            </div>
            {bundleState.stage === 'preview' || bundleState.stage === 'uploading' ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground">
                  <span>
                    Diagnostic bundle · {bundleState.bundle.spanCount} span(s) ·{' '}
                    {Math.round(bundleState.bundle.bytes / 1024)} KB
                  </span>
                  <span>ID: {bundleState.bundle.bundleSubmissionId}</span>
                </div>
                <textarea
                  value={bundleState.editedPayload}
                  readOnly={bundleState.stage === 'uploading'}
                  onChange={(event) =>
                    bundleState.stage === 'preview'
                      ? setBundleState({ ...bundleState, editedPayload: event.target.value })
                      : undefined
                  }
                  spellCheck={false}
                  className="h-72 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-tight outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                />
              </div>
            ) : (
              <div className="rounded-md border border-border/70 bg-muted/20 p-3 text-xs text-muted-foreground">
                Local traces stay on this machine. Sending requires collecting a bundle, reviewing
                the exact NDJSON payload, then confirming the upload.
              </div>
            )}
          </div>
        ) : (
          <div className="rounded-md border border-border/70 bg-muted/30 p-3 text-xs text-muted-foreground">
            {loading ? 'Checking for crash reports...' : 'No pending crash report is available.'}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" size="sm" onClick={handleCopy} disabled={!report}>
            <Clipboard className="size-3.5" />
            Copy Details
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleDismiss}
            disabled={bundleState.stage === 'uploading'}
          >
            Don&apos;t Send
          </Button>
          {bundleState.stage === 'preview' || bundleState.stage === 'uploading' ? (
            <Button
              type="button"
              size="sm"
              onClick={handleUploadBundle}
              disabled={!report || bundleState.stage === 'uploading'}
            >
              <Send className="size-3.5" />
              {bundleState.stage === 'uploading' ? 'Sending...' : 'Send Bundle'}
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              onClick={handleCollectBundle}
              disabled={!report || bundleState.stage === 'collecting'}
            >
              <FileText className="size-3.5" />
              {bundleState.stage === 'collecting' ? 'Collecting...' : 'Review Bundle'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

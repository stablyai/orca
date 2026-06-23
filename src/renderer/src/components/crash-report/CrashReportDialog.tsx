import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT,
  takePendingReactErrorBoundaryReport
} from '@/lib/react-error-boundary-reporting'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'

const CrashReportDialogSurface = lazy(() =>
  import('./CrashReportDialogSurface').then((module) => ({
    default: module.CrashReportDialogSurface
  }))
)

export function CrashReportDialog(): React.JSX.Element | null {
  const promptedThisLaunch = useRef(false)
  const mountedRef = useMountedRef()
  const [open, setOpen] = useState(false)
  const [report, setReport] = useState<CrashReportRecord | null>(null)
  const [loading, setLoading] = useState(false)

  const openCrashReport = useCallback((nextReport: CrashReportRecord): void => {
    setReport(nextReport)
    setOpen(true)
  }, [])

  const loadCrashReport = useCallback(
    async (promptIfPresent: boolean): Promise<void> => {
      setLoading(true)
      try {
        const nextReport = promptIfPresent
          ? await window.api.crashReports.getLatestPending()
          : await window.api.crashReports.getLatestReport()
        let displayedReport = nextReport
        if (nextReport?.status === 'pending' && promptIfPresent) {
          try {
            // Why: startup crash prompts are one-shot. The lazy dialog keeps the
            // report data locally if the user sends immediately, while Help >
            // Report Crash can still reopen dismissed unsent reports.
            await window.api.crashReports.dismiss({ reportId: nextReport.id })
            displayedReport = { ...nextReport, status: 'dismissed' as const }
          } catch (error) {
            console.error('Failed to dismiss crash report after startup prompt:', error)
          }
        }
        if (!mountedRef.current) {
          return
        }
        setReport(displayedReport)
        if (nextReport && promptIfPresent) {
          setOpen(true)
        }
      } catch (error) {
        console.error('Failed to load crash report:', error)
      } finally {
        if (mountedRef.current) {
          setLoading(false)
        }
      }
    },
    [mountedRef]
  )

  useEffect(() => {
    if (promptedThisLaunch.current) {
      return
    }
    promptedThisLaunch.current = true
    void loadCrashReport(true)
  }, [loadCrashReport])

  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      setReport(null)
      setOpen(true)
      void loadCrashReport(false)
    })
  }, [loadCrashReport])

  useEffect(() => {
    const pendingReport = takePendingReactErrorBoundaryReport()
    if (pendingReport) {
      openCrashReport(pendingReport)
    }

    const onReactErrorBoundaryReport = (): void => {
      const nextReport = takePendingReactErrorBoundaryReport()
      if (nextReport) {
        openCrashReport(nextReport)
      }
    }

    window.addEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, onReactErrorBoundaryReport)
    return () => {
      window.removeEventListener(
        REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT,
        onReactErrorBoundaryReport
      )
    }
  }, [openCrashReport])

  if (!open) {
    return null
  }

  return (
    <Suspense fallback={null}>
      <CrashReportDialogSurface
        open={open}
        report={report}
        loading={loading}
        onOpenChange={setOpen}
        onReportChange={setReport}
      />
    </Suspense>
  )
}

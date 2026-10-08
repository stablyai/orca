import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'
import { readStartupDiscovery } from '@/startup/startup-discovery-read'
import { useMountedRef } from '@/hooks/useMountedRef'
import {
  REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT,
  takePendingReactErrorBoundaryReports
} from '@/lib/react-error-boundary-reporting'
import { DialogEntryScope, useDialogDisposal } from '@/lib/dialog-registry-entry'
import { useDialogRegistry } from '@/store/dialog-registry'
import { selectAdmittedDialog } from '@/store/dialog-registry-state'
import { RecoverableRenderErrorBoundary } from '../error-boundaries/RecoverableRenderErrorBoundary'
import { useCrashReportSends } from './use-crash-report-sends'
import type { CrashReportRecord } from '../../../../shared/crash-reporting'

const CrashReportDialogSurface = lazy(() =>
  import('./CrashReportDialogSurface').then((module) => ({
    default: module.CrashReportDialogSurface
  }))
)

/** Help > Report Crash's own entry. */
const USER_DIALOG_TOKEN = 'crash-report-dialog:user'

function crashReportToken(reportId: string): string {
  return `crash-report:${reportId}`
}

/** Help > Report Crash, opened over no report: the latest one, once loaded. */
type UserDialog = { report: CrashReportRecord | null }

export function CrashReportDialog(): React.JSX.Element | null {
  const promptedThisLaunch = useRef(false)
  const pendingLaunchAckToken = useRef<string | null>(null)
  const mountedRef = useMountedRef()
  const [userDialog, setUserDialog] = useState<UserDialog | null>(null)
  const [loading, setLoading] = useState(false)
  const [reports, setReports] = useState<ReadonlyMap<string, CrashReportRecord>>(() => new Map())
  const admitted = useDialogRegistry((s) => selectAdmittedDialog(s, 'crash-report'))
  const admittedReport = admitted ? reports.get(admitted.token) : undefined
  const ownedTokens = useRef(new Set<string>())
  const disposeReports = useCallback(() => {
    pendingLaunchAckToken.current = null
    const registry = useDialogRegistry.getState()
    for (const token of ownedTokens.current) {
      registry.endDialog(token)
    }
    registry.settleStartupSource('crash-report', 'unavailable')
  }, [])
  useDialogDisposal(USER_DIALOG_TOKEN, disposeReports)

  const raiseCrashReport = useCallback((report: CrashReportRecord) => {
    const token = crashReportToken(report.id)
    // Repeated delivery of an identical ID must not reopen a dismissed report.
    if (ownedTokens.current.has(token)) {
      return
    }
    ownedTokens.current.add(token)
    setReports((current) => (current.has(token) ? current : new Map(current).set(token, report)))
    useDialogRegistry.getState().enqueueAutomaticDialog(token, 'crash-report')
  }, [])

  // By id, not by who opened it: a send started before Help took the dialog over lands either way.
  const changeReport = useCallback((report: CrashReportRecord | null) => {
    if (!report) {
      return
    }
    const token = crashReportToken(report.id)
    setUserDialog((current) =>
      current?.report?.id === report.id ? { ...current, report } : current
    )
    setReports((current) => {
      return current.has(token) ? new Map(current).set(token, report) : current
    })
  }, [])

  // Done with a report however it opened: one report, one dialog.
  const closeReport = useCallback((reportId: string | null) => {
    if (reportId === null) {
      return
    }
    const token = crashReportToken(reportId)
    useDialogRegistry.getState().closeDialog(token)
  }, [])

  const { send, isSending } = useCrashReportSends(
    useCallback(
      (reportId: string | null, sent: CrashReportRecord | null) => {
        changeReport(sent)
        // A dialog showing another report stays open.
        setUserDialog((current) => ((current?.report?.id ?? null) === reportId ? null : current))
        closeReport(reportId)
      },
      [changeReport, closeReport]
    )
  )

  useEffect(() => {
    if (promptedThisLaunch.current) {
      return
    }
    promptedThisLaunch.current = true
    void readStartupDiscovery(
      window.api.crashReports.getLatestPending().then((report) => ({ report }))
    ).then((result) => {
      if (!mountedRef.current) {
        // No owner left to show it; later dialogs must not wait on it.
        useDialogRegistry.getState().settleStartupSource('crash-report', 'unavailable')
        return
      }
      const pending = result?.report
      if (pending) {
        pendingLaunchAckToken.current =
          pending.status === 'pending' ? crashReportToken(pending.id) : null
        raiseCrashReport(pending)
      }
      useDialogRegistry
        .getState()
        .settleStartupSource(
          'crash-report',
          result === null ? 'unavailable' : pending ? 'ready' : 'none'
        )
    })
  }, [mountedRef, raiseCrashReport])

  useEffect(() => {
    const raisePending = (): void => {
      for (const report of takePendingReactErrorBoundaryReports()) {
        raiseCrashReport(report)
      }
    }
    raisePending()
    window.addEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, raisePending)
    return () =>
      window.removeEventListener(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT, raisePending)
  }, [raiseCrashReport])

  // From the committed content: the lazy surface may load well after the turn is granted.
  const visibleToken = admitted?.phase === 'visible' ? admitted.token : null
  useEffect(() => {
    const report = visibleToken === null ? undefined : reports.get(visibleToken)
    if (!report || visibleToken !== pendingLaunchAckToken.current) {
      return
    }
    pendingLaunchAckToken.current = null
    // Why: startup crash prompts are one-shot. Never awaited: a failed write must not hold the
    // prompt back, and the dialog dismisses a still-pending report on close. Help > Report Crash
    // can still reopen dismissed unsent reports.
    void window.api.crashReports
      .dismiss({ reportId: report.id })
      .then(() => {
        if (mountedRef.current) {
          changeReport({ ...report, status: 'dismissed' as const })
        }
      })
      .catch((error) => {
        console.error('Failed to dismiss crash report after startup prompt:', error)
      })
  }, [changeReport, mountedRef, reports, visibleToken])

  const loadUserCrashReport = useCallback(async (): Promise<void> => {
    setLoading(true)
    try {
      const latest = await window.api.crashReports.getLatestReport()
      if (mountedRef.current && latest) {
        // Only into a dialog still waiting for one; a report already shown is never swapped.
        setUserDialog((current) =>
          current && current.report === null ? { report: latest } : current
        )
      }
    } catch (error) {
      console.error('Failed to load crash report:', error)
    } finally {
      if (mountedRef.current) {
        setLoading(false)
      }
    }
  }, [mountedRef])

  const reportOnScreen = admitted?.phase === 'visible'
  useEffect(() => {
    return window.api.ui.onOpenCrashReport(() => {
      // A report dialog already up is the one Help would show: it stays as it is, notes and all.
      if (userDialog !== null || reportOnScreen) {
        return
      }
      setUserDialog({ report: null })
      void loadUserCrashReport()
    })
  }, [loadUserCrashReport, reportOnScreen, userDialog])

  if (userDialog === null && !admittedReport) {
    return null
  }
  const report = userDialog ? userDialog.report : (admittedReport ?? null)
  const surfaceKey = userDialog ? USER_DIALOG_TOKEN : admitted?.token
  const open = userDialog !== null || admitted?.phase !== 'closing'

  return (
    <DialogEntryScope
      token={userDialog ? USER_DIALOG_TOKEN : (admitted?.token ?? USER_DIALOG_TOKEN)}
    >
      <RecoverableRenderErrorBoundary
        boundaryId="modal.crash-report-content"
        surface="modal"
        reportAsCrash={false}
        compact
        key={surfaceKey}
        onError={() => {
          if (admitted && !userDialog) {
            useDialogRegistry.getState().endDialog(admitted.token)
          }
          setUserDialog(null)
        }}
      >
        <Suspense fallback={null}>
          <CrashReportDialogSurface
            key={surfaceKey}
            open={open}
            report={report}
            loading={loading && report === null}
            onOpenChange={(nextOpen) => {
              if (!nextOpen) {
                setUserDialog(null)
                closeReport(report?.id ?? null)
              }
            }}
            onReportChange={changeReport}
            submitting={isSending(report)}
            onSubmit={(request) => send(report, request)}
          />
        </Suspense>
      </RecoverableRenderErrorBoundary>
    </DialogEntryScope>
  )
}

import type React from 'react'
import type {
  CrashReportRecord,
  ReactErrorBoundaryReportArgs
} from '../../../shared/crash-reporting'

type RendererErrorContext = Pick<
  ReactErrorBoundaryReportArgs,
  'activeView' | 'activeModal' | 'activeTabType' | 'activeRightSidebarTab' | 'hasActiveWorktree'
>

type BuildReportArgsInput = {
  boundaryId: string
  surface: ReactErrorBoundaryReportArgs['surface']
  error: unknown
  errorInfo?: React.ErrorInfo
  context?: RendererErrorContext
}

const reportedRendererErrorKeys: string[] = []
const reportedRendererErrorKeySet = new Set<string>()
const MAX_REPORTED_RENDERER_ERROR_KEYS = 50
let pendingReactErrorBoundaryReport: CrashReportRecord | null = null

export const REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT =
  'orca:react-error-boundary-report-available'

function stringFromThrown(value: unknown): { name: string; message: string; stack?: string } {
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: value.message || String(value),
      ...(value.stack ? { stack: value.stack } : {})
    }
  }

  return {
    name: 'NonErrorThrown',
    message: String(value)
  }
}

async function collectRendererErrorContext(): Promise<RendererErrorContext> {
  try {
    const { useAppStore } = await import('@/store')
    const state = useAppStore.getState()
    return {
      activeView: state.activeView,
      activeModal: state.activeModal,
      activeTabType: state.activeTabType,
      activeRightSidebarTab: state.rightSidebarTab,
      hasActiveWorktree: state.activeWorktreeId !== null
    }
  } catch {
    return {}
  }
}

export function buildReactErrorBoundaryReportArgs({
  boundaryId,
  surface,
  error,
  errorInfo,
  context
}: BuildReportArgsInput): ReactErrorBoundaryReportArgs {
  const fields = stringFromThrown(error)
  const componentStack = errorInfo?.componentStack?.trim()
  return {
    boundaryId,
    surface,
    errorName: fields.name,
    errorMessage: fields.message,
    ...(fields.stack ? { errorStack: fields.stack } : {}),
    ...(componentStack ? { componentStack } : {}),
    ...(context?.activeView ? { activeView: context.activeView } : {}),
    ...(context?.activeModal !== undefined ? { activeModal: context.activeModal } : {}),
    ...(context?.activeTabType ? { activeTabType: context.activeTabType } : {}),
    ...(context?.activeRightSidebarTab
      ? { activeRightSidebarTab: context.activeRightSidebarTab }
      : {}),
    ...(context?.hasActiveWorktree !== undefined
      ? { hasActiveWorktree: context.hasActiveWorktree }
      : {})
  }
}

function rememberRendererErrorKey(key: string): boolean {
  if (reportedRendererErrorKeySet.has(key)) {
    return false
  }
  reportedRendererErrorKeySet.add(key)
  reportedRendererErrorKeys.push(key)
  if (reportedRendererErrorKeys.length > MAX_REPORTED_RENDERER_ERROR_KEYS) {
    const expiredKey = reportedRendererErrorKeys.shift()
    if (expiredKey) {
      reportedRendererErrorKeySet.delete(expiredKey)
    }
  }
  return true
}

function getRendererErrorKey(args: ReactErrorBoundaryReportArgs): string {
  return JSON.stringify({
    boundaryId: args.boundaryId,
    surface: args.surface,
    errorName: args.errorName,
    errorMessage: args.errorMessage,
    componentStack: args.componentStack
  })
}

export function takePendingReactErrorBoundaryReport(): CrashReportRecord | null {
  const report = pendingReactErrorBoundaryReport
  pendingReactErrorBoundaryReport = null
  return report
}

function notifyReactErrorBoundaryReportAvailable(report: CrashReportRecord): void {
  pendingReactErrorBoundaryReport = report
  window.dispatchEvent(new CustomEvent(REACT_ERROR_BOUNDARY_REPORT_AVAILABLE_EVENT))
}

export async function reportReactErrorBoundaryCrash(
  input: Omit<BuildReportArgsInput, 'context'>
): Promise<void> {
  const context = await collectRendererErrorContext()
  const args = buildReactErrorBoundaryReportArgs({ ...input, context })
  if (!rememberRendererErrorKey(getRendererErrorKey(args))) {
    return
  }

  try {
    const result = await window.api?.crashReports?.recordRendererError?.(args)
    if (result && !result.ok) {
      console.warn('[react-error-boundary] Failed to record renderer crash:', result.error)
      return
    }
    if (result?.ok && result.report && !result.deduped) {
      notifyReactErrorBoundaryReportAvailable(result.report)
    }
  } catch (error) {
    console.warn('[react-error-boundary] Crash reporting IPC failed:', error)
  }
}

export function clearReactErrorBoundaryReportingForTest(): void {
  reportedRendererErrorKeys.length = 0
  reportedRendererErrorKeySet.clear()
  pendingReactErrorBoundaryReport = null
}

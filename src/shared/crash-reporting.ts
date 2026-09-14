import {
  appendDiagnosticBundleLines,
  type CrashReportDiagnosticBundle
} from './crash-reporting-diagnostic-bundle'
import { appendMinidumpSignatureLines } from './crash-report-signature-lines'
import { formatCrashReportExitCode } from './crash-report-exit-code'
import { appendBoundaryAttributionLines } from './crash-report-attribution-lines'
import type { CrashReportAttribution } from './react-update-depth-attribution'
import { sanitizeCrashReportString } from './crash-report-redaction'

export {
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString
} from './crash-report-redaction'

export type { CrashReportDiagnosticBundle } from './crash-reporting-diagnostic-bundle'

export type CrashReportStatus = 'pending' | 'sent' | 'dismissed'
export type CrashReportSource = 'renderer' | 'child'

export type CrashReportDetailValue = string | number | boolean | null
export type CrashReportBreadcrumbData = Record<string, CrashReportDetailValue>

export type CrashReportBreadcrumb = {
  createdAt: string
  name: string
  data?: CrashReportBreadcrumbData
  origin?: string
}

export type CrashReportBreadcrumbInput = Omit<CrashReportBreadcrumb, 'data'> & {
  data?: Record<string, unknown>
}

export type CrashReportRecord = {
  id: string
  createdAt: string
  status: CrashReportStatus
  source: CrashReportSource
  processType: string
  reason: string
  exitCode: number | null
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
  electronVersion: string
  chromeVersion: string
  details: Record<string, CrashReportDetailValue>
  breadcrumbs?: CrashReportBreadcrumb[]
}
export type UncapturedCrashReportContext = {
  createdAt: string
  appVersion: string
  platform: NodeJS.Platform
  osRelease: string
  arch: string
  electronVersion: string
  chromeVersion: string
}
export type CrashReportCreateInput = Omit<
  CrashReportRecord,
  'id' | 'createdAt' | 'status' | 'details' | 'breadcrumbs'
> & {
  details: Record<string, unknown>
  breadcrumbs?: CrashReportBreadcrumbInput[]
}
export type ReactErrorBoundarySurface =
  | 'app-root'
  | 'web-root'
  | 'workspace-shell'
  | 'sidebar'
  | 'terminal-workbench'
  | 'right-sidebar'
  | 'page'
  | 'modal'
  | 'overlay'
  | 'rich-markdown-editor'
  | 'dashboard-popout'

export type ReactErrorBoundaryReportArgs = {
  boundaryId: string
  surface: ReactErrorBoundarySurface
  errorName: string
  errorMessage: string
  errorStack?: string
  componentStack?: string
  activeView?: string
  activeModal?: string | null
  activeTabType?: string | null
  activeRightSidebarTab?: string | null
  hasActiveWorktree?: boolean
  // Absent means "attribution is as trustworthy as it ever was"; older hosts ignore it.
  attribution?: CrashReportAttribution
}

export type ReactErrorBoundaryReportResult =
  | { ok: true; report: CrashReportRecord | null; deduped: boolean }
  | { ok: false; error: string }

export type CrashReportSubmitArgs = {
  reportId?: string
  notes?: string
  includeDiagnosticLogs?: boolean
  submitAnonymously?: boolean
  githubLogin: string | null
  githubEmail: string | null
}

export type CrashReportSubmitResult =
  | { ok: true; report: CrashReportRecord | null; diagnosticBundle?: CrashReportDiagnosticBundle }
  | {
      ok: false
      status: number | null
      error: string
      report?: CrashReportRecord | null
      diagnosticBundle?: CrashReportDiagnosticBundle
    }

export type CrashReportCopySubmissionFailure = {
  error: string
  diagnosticContext?:
    | { status: 'uploaded'; ticketId: string }
    | { status: 'not_uploaded'; reason: string }
}

export type CrashReportCopyDiagnosticsArgs = {
  reportId?: string
  notes?: string
  submissionFailure?: CrashReportCopySubmissionFailure
}

// User notes need a prose budget, separate from 240-character telemetry values.
export const MAX_USER_NOTES_LENGTH = 8_000
// Bound redaction work while allowing redacted input to contract into the output budget.
const MAX_USER_NOTES_SANITIZE_LENGTH = MAX_USER_NOTES_LENGTH * 2
const USER_NOTES_TRUNCATION_SUFFIX = '...'
const MAX_FORMATTED_REPORT_LENGTH = 64_000
const FORMATTED_REPORT_TRUNCATION_SUFFIX =
  '\n\n[Crash report truncated to fit feedback endpoint limits.]'
export function isCrashReportReason(reason: string): boolean {
  return [
    'abnormal-exit',
    'crashed',
    'integrity-failure',
    'killed',
    'launch-failed',
    'memory-eviction',
    'oom'
  ].includes(reason)
}

export function isReactErrorBoundaryReport(report: CrashReportRecord): boolean {
  return (
    report.source === 'renderer' &&
    report.processType === 'react-render' &&
    report.reason === 'react-error-boundary'
  )
}

// Notes lead so endpoint truncation removes reproducible machine data first.
const USER_NOTES_BEGIN = '--- begin user notes ---'
const USER_NOTES_END = '--- end user notes ---'

function appendUserNotesLines(lines: string[], notes: string | undefined): void {
  if (!notes) {
    return
  }
  const inputWasClamped = notes.length > MAX_USER_NOTES_SANITIZE_LENGTH
  const boundedNotes = notes.slice(0, MAX_USER_NOTES_SANITIZE_LENGTH).trim()
  if (!boundedNotes) {
    return
  }
  const sanitized = sanitizeCrashReportString(boundedNotes, MAX_USER_NOTES_SANITIZE_LENGTH)
  const wasTruncated = inputWasClamped || sanitized.length > MAX_USER_NOTES_LENGTH
  const formattedNotes = wasTruncated
    ? `${sanitized
        .slice(0, MAX_USER_NOTES_LENGTH - USER_NOTES_TRUNCATION_SUFFIX.length)
        .trimEnd()}${USER_NOTES_TRUNCATION_SUFFIX}`
    : sanitized
  // Indentation prevents user text from impersonating line-oriented machine sections.
  lines.push(
    '',
    'User notes:',
    USER_NOTES_BEGIN,
    ...formattedNotes.split('\n').map((line) => `  ${line}`),
    USER_NOTES_END
  )
}

export function formatCrashReportText(
  report: CrashReportRecord,
  notes?: string,
  diagnosticBundle?: CrashReportDiagnosticBundle
): string {
  const lines = [
    '[Crash Report]',
    '',
    `Report ID: ${report.id}`,
    `Created: ${report.createdAt}`,
    `Status: ${report.status}`,
    `Source: ${report.source}`,
    `Process: ${report.processType}`,
    `Reason: ${report.reason}`,
    `Exit code: ${formatCrashReportExitCode(report)}`,
    `App version: ${report.appVersion}`,
    `Platform: ${report.platform} ${report.osRelease} ${report.arch}`,
    `Electron: ${report.electronVersion}`,
    `Chrome: ${report.chromeVersion}`
  ]

  appendUserNotesLines(lines, notes)
  appendMinidumpSignatureLines(lines, report.details)
  appendBoundaryAttributionLines(lines, report.details)
  appendDiagnosticBundleLines(lines, diagnosticBundle, sanitizeCrashReportString)

  const details = Object.entries(report.details)
  if (details.length > 0) {
    lines.push('', 'Details:')
    for (const [key, value] of details) {
      lines.push(`- ${key}: ${String(value)}`)
    }
  }

  if (report.breadcrumbs && report.breadcrumbs.length > 0) {
    lines.push('', 'Recent activity:')
    for (const breadcrumb of report.breadcrumbs) {
      const data = breadcrumb.data ? Object.entries(breadcrumb.data) : []
      const suffix =
        data.length > 0
          ? ` (${data.map(([key, value]) => `${key}=${String(value)}`).join(', ')})`
          : ''
      lines.push(`- ${breadcrumb.createdAt}: ${breadcrumb.name}${suffix}`)
    }
  }

  return truncateFormattedCrashReport(lines.join('\n'))
}

export function formatUncapturedCrashReportText(
  context: UncapturedCrashReportContext,
  notes?: string,
  diagnosticBundle?: CrashReportDiagnosticBundle
): string {
  const lines = [
    '[Crash Report]',
    '',
    'Report ID: not captured',
    `Created: ${context.createdAt}`,
    'Status: uncaptured',
    'Source: user-reported',
    'Process: unknown',
    'Reason: no captured crash report',
    'Exit code: unknown',
    `App version: ${context.appVersion}`,
    `Platform: ${context.platform} ${context.osRelease} ${context.arch}`,
    `Electron: ${context.electronVersion}`,
    `Chrome: ${context.chromeVersion}`
  ]

  appendUserNotesLines(lines, notes)
  lines.push('', 'Details:', '- captured_crash_report: false', '- report_source: help_menu')
  appendDiagnosticBundleLines(lines, diagnosticBundle, sanitizeCrashReportString)

  return truncateFormattedCrashReport(lines.join('\n'))
}

function truncateFormattedCrashReport(text: string): string {
  if (text.length <= MAX_FORMATTED_REPORT_LENGTH) {
    return text
  }
  // The report cap leaves Slack-specific attachment handling to the feedback service.
  const budget = MAX_FORMATTED_REPORT_LENGTH - FORMATTED_REPORT_TRUNCATION_SUFFIX.length
  return `${text.slice(0, Math.max(0, budget)).trimEnd()}${FORMATTED_REPORT_TRUNCATION_SUFFIX}`
}

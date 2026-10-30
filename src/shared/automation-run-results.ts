import type { AutomationRun } from './automations-types'
import type { AutomationRunOutput, AutomationRunWarning } from './automation-run-result-types'

// Runs live in the whole-store blob, so every reported field is bounded.
export const MAX_AUTOMATION_RUN_WARNINGS = 10
export const MAX_AUTOMATION_RUN_OUTPUTS = 10
export const MAX_AUTOMATION_RUN_WARNING_KEY_LENGTH = 100
export const MAX_AUTOMATION_RUN_MESSAGE_LENGTH = 1_000
export const MAX_AUTOMATION_RUN_EVIDENCE_LENGTH = 2_048
export const MAX_AUTOMATION_RUN_OUTPUT_TITLE_LENGTH = 200
/** Fits the CLI/SSH control frame and the mobile bridge frame in one request. */
export const MAX_AUTOMATION_RUN_OUTPUT_BYTES = 600 * 1024
/** Late reports from an agent's final turn still land after the run settles. */
export const AUTOMATION_RUN_REPORT_GRACE_MS = 15 * 60 * 1000

export type AutomationRunReport =
  | {
      kind: 'warning'
      key: string
      message: string
      impact: string | null
      evidence: string | null
    }
  | { kind: 'resolve-warning'; key: string; resolution: string | null }
  | { kind: 'failure'; message: string }
  | { kind: 'output'; output: AutomationRunOutput }

export type AutomationRunReportOutcome =
  | { ok: true; run: AutomationRun }
  | { ok: false; reason: 'warning_limit' | 'output_limit' | 'unknown_warning' }

/** Pure: apply one agent report; repeated keys update in place so retries never pile up. */
export function applyAutomationRunReport(
  run: AutomationRun,
  report: AutomationRunReport,
  now: number
): AutomationRunReportOutcome {
  const warnings = run.warnings ?? []
  switch (report.kind) {
    case 'warning': {
      const existing = warnings.find((warning) => warning.key === report.key)
      if (!existing && warnings.length >= MAX_AUTOMATION_RUN_WARNINGS) {
        return { ok: false, reason: 'warning_limit' }
      }
      const next: AutomationRunWarning = {
        key: report.key,
        message: report.message,
        impact: report.impact ?? existing?.impact ?? null,
        evidence: report.evidence ?? existing?.evidence ?? null,
        firstReportedAt: existing?.firstReportedAt ?? now,
        lastReportedAt: now,
        reportCount: (existing?.reportCount ?? 0) + 1,
        // Reporting a resolved key again reopens it.
        resolvedAt: null,
        resolution: null
      }
      return {
        ok: true,
        run: {
          ...run,
          warnings: existing
            ? warnings.map((warning) => (warning.key === report.key ? next : warning))
            : [...warnings, next]
        }
      }
    }
    case 'resolve-warning': {
      if (!warnings.some((warning) => warning.key === report.key)) {
        return { ok: false, reason: 'unknown_warning' }
      }
      return {
        ok: true,
        run: {
          ...run,
          warnings: warnings.map((warning) =>
            warning.key === report.key
              ? { ...warning, resolvedAt: now, resolution: report.resolution }
              : warning
          )
        }
      }
    }
    case 'failure':
      // A run that already finished cleanly has no later completion to convert.
      if (run.status === 'completed') {
        return {
          ok: true,
          run: {
            ...run,
            status: 'dispatch_failed',
            error: report.message,
            reportedFailure: { message: report.message, reportedAt: now }
          }
        }
      }
      return {
        ok: true,
        run: { ...run, reportedFailure: { message: report.message, reportedAt: now } }
      }
    case 'output': {
      const outputs = run.outputs ?? []
      if (outputs.length >= MAX_AUTOMATION_RUN_OUTPUTS) {
        return { ok: false, reason: 'output_limit' }
      }
      return { ok: true, run: { ...run, outputs: [...outputs, report.output] } }
    }
  }
}

/** Methods whose caller is resolved from the CLI's injected session evidence. */
export const AUTOMATION_RUN_CALLER_METHODS: ReadonlySet<string> = new Set([
  'automation.reportWarning',
  'automation.reportFailure',
  'automation.attachOutput'
])

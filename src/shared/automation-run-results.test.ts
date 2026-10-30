import { describe, expect, it } from 'vitest'
import type { AutomationRun } from './automations-types'
import {
  MAX_AUTOMATION_RUN_WARNINGS,
  applyAutomationRunReport,
  type AutomationRunReport
} from './automation-run-results'

const run = { id: 'r1', automationId: 'a1' } as AutomationRun

function warning(key: string, message = `${key} missing`): AutomationRunReport {
  return { kind: 'warning', key, message, impact: null, evidence: null }
}

function apply(current: AutomationRun, report: AutomationRunReport, now: number): AutomationRun {
  const outcome = applyAutomationRunReport(current, report, now)
  if (!outcome.ok) {
    throw new Error(outcome.reason)
  }
  return outcome.run
}

describe('applyAutomationRunReport', () => {
  it('updates a repeated key in place instead of adding a warning per retry', () => {
    let current = apply(run, warning('linear', 'first'), 1)
    current = apply(current, warning('linear', 'second'), 2)

    expect(current.warnings).toEqual([
      expect.objectContaining({
        key: 'linear',
        message: 'second',
        firstReportedAt: 1,
        lastReportedAt: 2,
        reportCount: 2
      })
    ])
  })

  it('keeps a resolved warning as history and reopens it when reported again', () => {
    let current = apply(run, warning('linear'), 1)
    current = apply(current, { kind: 'resolve-warning', key: 'linear', resolution: 'retry' }, 2)

    expect(current.warnings?.[0]).toMatchObject({ resolvedAt: 2, resolution: 'retry' })

    current = apply(current, warning('linear'), 3)
    expect(current.warnings?.[0]).toMatchObject({ resolvedAt: null, reportCount: 2 })
  })

  it('refuses a new key past the cap and resolving a key never reported', () => {
    let current = run
    for (let index = 0; index < MAX_AUTOMATION_RUN_WARNINGS; index++) {
      current = apply(current, warning(`k${index}`), index)
    }

    expect(applyAutomationRunReport(current, warning('extra'), 99)).toEqual({
      ok: false,
      reason: 'warning_limit'
    })
    expect(applyAutomationRunReport(current, warning('k0'), 99).ok).toBe(true)
    expect(
      applyAutomationRunReport(run, { kind: 'resolve-warning', key: 'nope', resolution: null }, 1)
    ).toEqual({ ok: false, reason: 'unknown_warning' })
  })

  it('fails a run that already finished cleanly instead of waiting for a completion', () => {
    const finished = { ...run, status: 'completed', error: null } as AutomationRun

    expect(apply(finished, { kind: 'failure', message: 'No access' }, 5)).toMatchObject({
      status: 'dispatch_failed',
      error: 'No access',
      reportedFailure: { message: 'No access', reportedAt: 5 }
    })
  })
})

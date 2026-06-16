import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  buildAutomationLastRunByAutomationId,
  toLastRunStatusLookup
} from './automation-last-run-lookup'

function makeRun(
  overrides: Partial<AutomationRun> & Pick<AutomationRun, 'automationId'>
): AutomationRun {
  return {
    id: `${overrides.automationId}-${overrides.scheduledFor ?? 0}`,
    title: 'run',
    scheduledFor: 0,
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: 0,
    ...overrides
  }
}

describe('buildAutomationLastRunByAutomationId', () => {
  it('keeps the most recent run per automation by start/scheduled time', () => {
    const runs = [
      makeRun({ automationId: 'a', scheduledFor: 300, status: 'dispatch_failed' }),
      makeRun({ automationId: 'a', scheduledFor: 100, status: 'completed' }),
      makeRun({ automationId: 'b', scheduledFor: 50, status: 'skipped_missed' })
    ]
    const byId = buildAutomationLastRunByAutomationId(runs)
    expect(byId.get('a')).toEqual({ status: 'dispatch_failed', at: 300 })
    expect(byId.get('b')).toEqual({ status: 'skipped_missed', at: 50 })
  })

  it('prefers startedAt over scheduledFor when present', () => {
    const runs = [
      makeRun({ automationId: 'a', scheduledFor: 100, startedAt: 999, status: 'completed' }),
      makeRun({ automationId: 'a', scheduledFor: 500, status: 'dispatch_failed' })
    ]
    const byId = buildAutomationLastRunByAutomationId(runs)
    expect(byId.get('a')).toEqual({ status: 'completed', at: 999 })
  })

  it('projects to a plain status lookup', () => {
    const byId = buildAutomationLastRunByAutomationId([
      makeRun({ automationId: 'a', scheduledFor: 1, status: 'completed' })
    ])
    expect(toLastRunStatusLookup(byId)).toEqual({ a: 'completed' })
  })
})

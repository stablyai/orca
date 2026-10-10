import { describe, expect, it } from 'vitest'
import type { AutomationRun, AutomationRunUsage } from './automations-types'
import { summarizeAutomationRunUsage } from './automation-usage-summary'

const makeUsage = (overrides: Partial<AutomationRunUsage> = {}): AutomationRunUsage => ({
  status: 'known',
  provider: 'claude',
  model: 'sonnet',
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 3,
  cacheWriteTokens: 2,
  reasoningOutputTokens: 1,
  totalTokens: 21,
  estimatedCostUsd: 0.25,
  estimatedCostSource: 'api_equivalent',
  providerSessionId: 'session-1',
  attribution: 'provider_session_time_window',
  collectedAt: 1,
  unavailableReason: null,
  unavailableMessage: null,
  ...overrides
})

const makeRun = (usage: AutomationRunUsage | null): AutomationRun =>
  ({ id: 'run-1', automationId: 'a1', usage }) as AutomationRun

describe('summarizeAutomationRunUsage', () => {
  it('aggregates known runs and counts the rest as unavailable', () => {
    const summary = summarizeAutomationRunUsage([
      makeRun(makeUsage()),
      makeRun(makeUsage({ estimatedCostUsd: null })),
      makeRun(makeUsage({ status: 'unavailable' })),
      makeRun(null)
    ])

    expect(summary).toEqual({
      knownRuns: 2,
      unavailableRuns: 2,
      inputTokens: 20,
      outputTokens: 10,
      cacheTokens: 10,
      reasoningOutputTokens: 2,
      totalTokens: 42,
      estimatedCostUsd: 0.25,
      lastRunStatus: null,
      lastRunAt: null
    })
  })

  it('reports an unknown cost rather than zero when no run has one', () => {
    const summary = summarizeAutomationRunUsage([makeRun(makeUsage({ estimatedCostUsd: null }))])
    expect(summary.estimatedCostUsd).toBeNull()
    expect(summary.knownRuns).toBe(1)
  })

  it('summarizes an empty retained history without inventing usage', () => {
    expect(summarizeAutomationRunUsage([])).toEqual({
      knownRuns: 0,
      unavailableRuns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      lastRunStatus: null,
      lastRunAt: null
    })
  })

  it('projects the newest retained run so list filters never fetch history', () => {
    const summary = summarizeAutomationRunUsage([
      { ...makeRun(makeUsage()), createdAt: 1, status: 'completed', dispatchedAt: 11 },
      { ...makeRun(makeUsage()), createdAt: 3, status: 'dispatch_failed', dispatchedAt: 33 },
      { ...makeRun(makeUsage()), createdAt: 2, status: 'completed', dispatchedAt: 22 }
    ])
    expect(summary.lastRunStatus).toBe('dispatch_failed')
    expect(summary.lastRunAt).toBe(33)
  })
})

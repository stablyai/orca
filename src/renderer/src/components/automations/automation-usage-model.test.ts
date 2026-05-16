import { describe, expect, it } from 'vitest'
import type { AutomationRun } from '../../../../shared/automations-types'
import {
  formatAutomationCost,
  formatAutomationTokens,
  summarizeAutomationRunUsage
} from './automation-usage-model'

function makeRun(overrides: Partial<AutomationRun>): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Run 1',
    scheduledFor: 1,
    status: 'completed',
    trigger: 'manual',
    workspaceId: 'wt1',
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: 'tab-1',
    usage: null,
    error: null,
    startedAt: 1,
    dispatchedAt: 1,
    createdAt: 1,
    ...overrides
  }
}

describe('automation usage model', () => {
  it('rolls known run usage up while preserving unavailable coverage', () => {
    const summary = summarizeAutomationRunUsage([
      makeRun({
        usage: {
          status: 'known',
          provider: 'codex',
          model: 'gpt-5.4',
          inputTokens: 1000,
          outputTokens: 300,
          cacheReadTokens: 400,
          cacheWriteTokens: null,
          reasoningOutputTokens: 50,
          totalTokens: 1350,
          estimatedCostUsd: 0.0042,
          estimatedCostSource: 'api_equivalent',
          providerSessionId: 'session-1',
          attribution: 'provider_session_time_window',
          collectedAt: 1,
          unavailableReason: null,
          unavailableMessage: null
        }
      }),
      makeRun({
        id: 'run-2',
        usage: {
          status: 'unavailable',
          provider: 'claude',
          model: null,
          inputTokens: null,
          outputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          reasoningOutputTokens: null,
          totalTokens: null,
          estimatedCostUsd: null,
          estimatedCostSource: null,
          providerSessionId: null,
          attribution: null,
          collectedAt: 2,
          unavailableReason: 'no_matching_session',
          unavailableMessage: 'No matching session'
        }
      })
    ])

    expect(summary).toEqual({
      knownRuns: 1,
      unavailableRuns: 1,
      inputTokens: 1000,
      outputTokens: 300,
      cacheTokens: 400,
      reasoningOutputTokens: 50,
      totalTokens: 1350,
      estimatedCostUsd: 0.0042
    })
  })

  it('formats compact token and cost labels', () => {
    expect(formatAutomationTokens(1250)).toBe('1.3k')
    expect(formatAutomationTokens(1_250_000)).toBe('1.3M')
    expect(formatAutomationCost(null)).toBe('n/a')
    expect(formatAutomationCost(0.0042)).toBe('$0.0042')
    expect(formatAutomationCost(1.234)).toBe('$1.23')
  })
})

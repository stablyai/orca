import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from './agent-status-types'
import type { OrchestrationFleetAttentionCategory } from './orchestration-fleet-attention'
import {
  classifyAgentNotificationIntent,
  shouldSurfaceAgentNotification
} from './agent-notification-policy'

type Facts = Pick<
  AgentStatusEntry,
  | 'state'
  | 'interactivePrompt'
  | 'lastAssistantMessage'
  | 'lastAssistantMessageIsToolOutput'
  | 'sessionBoundary'
  | 'orchestration'
>

function facts(overrides: Partial<Facts> = {}): Facts {
  return { state: 'working', ...overrides }
}

function orchestration(
  categories: OrchestrationFleetAttentionCategory[],
  dispatchStatus: NonNullable<AgentStatusEntry['orchestration']>['dispatchStatus'] = 'dispatched'
): AgentStatusEntry['orchestration'] {
  return {
    taskId: 'task-1',
    dispatchId: 'dispatch-1',
    dispatchStatus,
    attention: { categories, requiresAction: categories.length > 0 }
  }
}

describe('agent notification policy', () => {
  it.each([
    ['working tool use', facts()],
    [
      'tool-only completion',
      facts({
        state: 'done',
        lastAssistantMessage: 'tool output',
        lastAssistantMessageIsToolOutput: true
      })
    ],
    ['generic waiting', facts({ state: 'waiting' })],
    ['generic blocked', facts({ state: 'blocked' })],
    [
      'session boundary',
      facts({ state: 'done', sessionBoundary: true, lastAssistantMessage: 'restored' })
    ],
    ['stale orchestration', facts({ orchestration: orchestration(['stale']) })]
  ])('classifies %s as progress', (_name, entry) => {
    expect(classifyAgentNotificationIntent(entry)).toBe('progress')
  })

  it('classifies assistant prose and root completion as results', () => {
    expect(
      classifyAgentNotificationIntent(facts({ state: 'done', lastAssistantMessage: 'Finished.' }))
    ).toBe('result')
    expect(
      classifyAgentNotificationIntent(facts({ orchestration: orchestration(['root_completion']) }))
    ).toBe('result')
  })

  it.each(['input', 'approval', 'guidance'] as const)(
    'classifies %s orchestration as action required',
    (category) => {
      expect(
        classifyAgentNotificationIntent(facts({ orchestration: orchestration([category]) }))
      ).toBe('action-required')
    }
  )

  it('classifies an interactive prompt as action required', () => {
    expect(
      classifyAgentNotificationIntent(facts({ interactivePrompt: '{"question":"Pick"}' }))
    ).toBe('action-required')
  })

  it.each(['failure', 'interruption', 'unverifiable'] as const)(
    'classifies %s orchestration as failure',
    (category) => {
      expect(
        classifyAgentNotificationIntent(facts({ orchestration: orchestration([category]) }))
      ).toBe('failure')
    }
  )

  it('classifies failed lifecycle states as failure', () => {
    expect(
      classifyAgentNotificationIntent(facts({ orchestration: orchestration([], 'failed') }))
    ).toBe('failure')
    expect(
      classifyAgentNotificationIntent(facts({ orchestration: orchestration([], 'circuit_broken') }))
    ).toBe('failure')
  })

  it('preserves legacy mode and filters only progress in result-focused mode', () => {
    expect(shouldSurfaceAgentNotification('all', 'progress')).toBe(true)
    expect(shouldSurfaceAgentNotification(undefined, undefined)).toBe(true)
    expect(shouldSurfaceAgentNotification('results-and-actions', undefined)).toBe(false)
    expect(shouldSurfaceAgentNotification('results-and-actions', 'progress')).toBe(false)
    expect(shouldSurfaceAgentNotification('results-and-actions', 'result')).toBe(true)
    expect(shouldSurfaceAgentNotification('results-and-actions', 'action-required')).toBe(true)
    expect(shouldSurfaceAgentNotification('results-and-actions', 'failure')).toBe(true)
  })
})

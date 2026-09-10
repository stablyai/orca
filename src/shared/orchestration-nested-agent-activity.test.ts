import { describe, expect, it } from 'vitest'
import {
  NESTED_AGENT_ACTIVITY_LIMIT,
  OrchestrationNestedAgentActivityListSchema,
  OrchestrationNestedAgentActivitySchema
} from './orchestration-nested-agent-activity'

const activity = {
  parent_dispatch_id: 'dispatch-1',
  parent_provider_session_id: 'session-1',
  provider_child_id: 'child-1',
  provider: 'codex',
  type: 'subagent',
  model: 'gpt-5',
  description: 'Inspects the contract boundaries.',
  state: 'running',
  started_at: '2026-08-28T12:00:00.000Z',
  updated_at: '2026-08-28T12:01:00.000Z'
} as const

describe('orchestration nested-agent activity', () => {
  it('accepts bounded parent-owned provider activity', () => {
    expect(OrchestrationNestedAgentActivitySchema.parse(activity)).toEqual(activity)
  })

  it('rejects independent Task and Dispatch authority fields', () => {
    expect(
      OrchestrationNestedAgentActivitySchema.safeParse({
        ...activity,
        task_id: 'task-child',
        dispatch_id: 'dispatch-child',
        cleanup_receipt: 'cleanup-child'
      }).success
    ).toBe(false)
  })

  it('requires terminal time only for terminal activity', () => {
    expect(
      OrchestrationNestedAgentActivitySchema.safeParse({
        ...activity,
        state: 'completed',
        completed_at: '2026-08-28T12:02:00.000Z'
      }).success
    ).toBe(true)
    expect(
      OrchestrationNestedAgentActivitySchema.safeParse({ ...activity, state: 'completed' }).success
    ).toBe(false)
    expect(
      OrchestrationNestedAgentActivitySchema.safeParse({
        ...activity,
        completed_at: '2026-08-28T12:02:00.000Z'
      }).success
    ).toBe(false)
  })

  it('rejects duplicate child identities and unbounded rosters', () => {
    expect(OrchestrationNestedAgentActivityListSchema.safeParse([activity, activity]).success).toBe(
      false
    )
    const roster = Array.from({ length: NESTED_AGENT_ACTIVITY_LIMIT + 1 }, (_, index) => ({
      ...activity,
      provider_child_id: `child-${index}`
    }))
    expect(OrchestrationNestedAgentActivityListSchema.safeParse(roster).success).toBe(false)
  })

  it('rejects impossible timestamp order', () => {
    expect(
      OrchestrationNestedAgentActivitySchema.safeParse({
        ...activity,
        updated_at: '2026-08-28T11:59:00.000Z'
      }).success
    ).toBe(false)
  })
})

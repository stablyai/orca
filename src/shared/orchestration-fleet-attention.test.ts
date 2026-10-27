import { describe, expect, it } from 'vitest'
import { projectOrchestrationFleetAttention } from './orchestration-fleet-attention'

describe('orchestration fleet attention', () => {
  it('keeps durable input, approval, failure, and interruption categories separate', () => {
    expect(
      projectOrchestrationFleetAttention({
        isRoot: false,
        outcome: 'failed',
        pendingInput: true,
        pendingApproval: true,
        interrupted: true,
        liveness: { verdict: 'live' }
      })
    ).toEqual({
      categories: ['input', 'approval', 'failure', 'interruption'],
      requiresAction: true
    })
  })

  it('distinguishes stale evidence from other unverifiable states', () => {
    expect(
      projectOrchestrationFleetAttention({
        isRoot: false,
        outcome: 'in_progress',
        liveness: { verdict: 'unverifiable', reason: 'stale_status' }
      }).categories
    ).toEqual(['stale'])
    expect(
      projectOrchestrationFleetAttention({
        isRoot: false,
        outcome: 'finished_unverified',
        liveness: { verdict: 'unverifiable', reason: 'host_unavailable' }
      }).categories
    ).toEqual(['unverifiable'])
  })

  it('projects only successful root work as root completion', () => {
    const child = projectOrchestrationFleetAttention({
      isRoot: false,
      outcome: 'succeeded',
      liveness: { verdict: 'exited' }
    })
    const root = projectOrchestrationFleetAttention({
      isRoot: true,
      outcome: 'succeeded',
      liveness: { verdict: 'exited' }
    })

    expect(child.categories).toEqual([])
    expect(root).toEqual({ categories: ['root_completion'], requiresAction: false })
  })
})

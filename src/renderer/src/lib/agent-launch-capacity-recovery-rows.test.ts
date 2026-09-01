import { describe, expect, it } from 'vitest'
import {
  capacityActionCopy,
  livenessCopy,
  resolveCapacityRowAction,
  sourceKindCopy,
  toCapacityRecoveryRowView
} from './agent-launch-capacity-recovery-rows'
import type { PendingAgentLaunchSummaryRow } from '../../../shared/agent-launch-pending-summary'

function row(overrides: Partial<PendingAgentLaunchSummaryRow> = {}): PendingAgentLaunchSummaryRow {
  return {
    sourceKind: 'interactive',
    baseHarness: 'claude',
    targetHostDisplayName: 'This Mac',
    admittedAt: 1_000,
    liveness: 'unknown',
    ...overrides
  }
}

describe('resolveCapacityRowAction', () => {
  it('opens the owning worktree when the row carries a worktree deep link', () => {
    const action = resolveCapacityRowAction(
      row({ deepLink: { kind: 'worktree', worktreeId: 'repo1::/tmp/wt' } })
    )
    expect(action).toEqual({ kind: 'open-worktree', worktreeId: 'repo1::/tmp/wt' })
  })

  it('is not routable for an ownerless row (no deep link admitted today)', () => {
    expect(resolveCapacityRowAction(row())).toBeNull()
  })

  it('opens the owning automation run for a run deep link (keyed off the run, not a worktree)', () => {
    const action = resolveCapacityRowAction(
      row({ deepLink: { kind: 'run', runId: 'r1', automationId: 'a1' } })
    )
    expect(action).toEqual({ kind: 'open-automation-run', automationId: 'a1', runId: 'r1' })
  })

  it('routes task and session owners to their owning worktree once the scope resolves', () => {
    expect(
      resolveCapacityRowAction(
        row({ deepLink: { kind: 'task', taskId: 't1', worktreeId: 'wt-t' } })
      )
    ).toEqual({ kind: 'open-worktree', worktreeId: 'wt-t' })
    expect(
      resolveCapacityRowAction(
        row({ deepLink: { kind: 'session', sessionId: 's1', worktreeId: 'wt-s' } })
      )
    ).toEqual({ kind: 'open-worktree', worktreeId: 'wt-s' })
  })

  it('is copy-only for task and session owners whose worktree scope has not resolved', () => {
    expect(resolveCapacityRowAction(row({ deepLink: { kind: 'task', taskId: 't1' } }))).toBeNull()
    expect(
      resolveCapacityRowAction(row({ deepLink: { kind: 'session', sessionId: 's1' } }))
    ).toBeNull()
  })
})

describe('capacityActionCopy', () => {
  it('labels a run action as "go to run" regardless of liveness', () => {
    const runAction = { kind: 'open-automation-run', automationId: 'a1', runId: 'r1' } as const
    expect(capacityActionCopy(runAction, 'live').key).toBe('agentLaunch.capacity.action.goToRun')
    expect(capacityActionCopy(runAction, 'absent').key).toBe('agentLaunch.capacity.action.goToRun')
    expect(capacityActionCopy(runAction, 'unknown').key).toBe('agentLaunch.capacity.action.goToRun')
  })

  it('labels a live worktree "open" and a non-live one "go to workspace"', () => {
    const worktreeAction = { kind: 'open-worktree', worktreeId: 'wt' } as const
    expect(capacityActionCopy(worktreeAction, 'live').key).toBe('agentLaunch.capacity.action.open')
    expect(capacityActionCopy(worktreeAction, 'absent').key).toBe(
      'agentLaunch.capacity.action.goToWorkspace'
    )
    expect(capacityActionCopy(worktreeAction, 'unknown').key).toBe(
      'agentLaunch.capacity.action.goToWorkspace'
    )
  })
})

describe('toCapacityRecoveryRowView', () => {
  it('projects the redacted fields and the resolved action', () => {
    const view = toCapacityRecoveryRowView(
      row({
        sourceKind: 'cli',
        liveness: 'live',
        deepLink: { kind: 'worktree', worktreeId: 'wt-1' }
      })
    )
    expect(view).toEqual({
      sourceKind: 'cli',
      hostDisplayName: 'This Mac',
      admittedAt: 1_000,
      liveness: 'live',
      action: { kind: 'open-worktree', worktreeId: 'wt-1' }
    })
  })
})

describe('copy helpers', () => {
  it('maps every source kind to a distinct key', () => {
    const kinds = [
      'interactive',
      'cli',
      'automation',
      'background',
      'orchestration',
      'resume'
    ] as const
    const keys = kinds.map((kind) => sourceKindCopy(kind).key)
    expect(new Set(keys).size).toBe(kinds.length)
  })

  it('maps every liveness to a distinct key', () => {
    const values = ['live', 'absent', 'unknown'] as const
    const keys = values.map((value) => livenessCopy(value).key)
    expect(new Set(keys).size).toBe(values.length)
  })
})

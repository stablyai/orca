import { describe, expect, it } from 'vitest'
import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { getMachineCreationStages } from './machine-creation-stages'

function entry(overrides: Partial<PendingWorktreeCreation>): PendingWorktreeCreation {
  return {
    creationId: 'c',
    phase: 'starting-machine',
    status: 'creating',
    startedAt: 0,
    indeterminate: true,
    loaderVisible: true,
    request: {
      repoId: 'r',
      name: 'feature',
      setupDecision: 'inherit',
      agent: null,
      pendingFirstAgentMessageRename: false,
      note: '',
      startupPlan: null,
      quickPrompt: '',
      quickTelemetry: null
    },
    ...overrides
  }
}

const states = (value: PendingWorktreeCreation): string[] =>
  getMachineCreationStages(value).map((stage) => `${stage.state}:${stage.detail}`)

describe('getMachineCreationStages', () => {
  it('names what the machine stage is doing', () => {
    expect(states(entry({ machineProgress: { activity: 'waking' } }))).toEqual([
      'active:Waking…',
      'pending:',
      'pending:'
    ])
  })

  it('ticks the machine stage with its duration once the repo stage starts', () => {
    expect(
      states(
        entry({
          phase: 'setting-up-project',
          machineProgress: { activity: 'connecting', readyAfterMs: 41_000 }
        })
      )
    ).toEqual(['done:41s', 'active:Cloning…', 'pending:'])
  })

  it('turns only the stage that failed red', () => {
    expect(states(entry({ phase: 'fetching', status: 'error' }))).toEqual([
      'done:',
      'failed:',
      'pending:'
    ])
  })

  it('shows a cancel as stopped, not failed', () => {
    expect(
      states(entry({ status: 'error', machineProgress: { activity: 'creating', canceled: true } }))
    ).toEqual(['stopped:Canceled', 'pending:', 'pending:'])
  })
})

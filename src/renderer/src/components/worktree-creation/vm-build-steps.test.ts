import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

import { appendStampedLog } from '@/lib/pending-creation-provisioning-log'
import { deriveVmBuildSteps } from './vm-build-steps'
import { classifyVmBuildFailure } from './vm-build-failure'
import { holdRunningSteps } from './use-minimum-running-steps'
import { humanizeOrcaCloudLogLine } from './orca-cloud-build-log'

const base = {
  status: 'creating' as const,
  phase: 'provisioning-vm' as const,
  startedAt: 1000,
  phaseLog: [{ phase: 'provisioning-vm' as const, at: 1000 }]
}

describe('deriveVmBuildSteps', () => {
  it('keeps the sheet moving through fetch and checkout instead of stalling on checks', () => {
    const steps = deriveVmBuildSteps(
      {
        ...base,
        phase: 'creating',
        phaseLog: [
          { phase: 'provisioning-vm', at: 1000 },
          { phase: 'fetching', at: 9000 },
          { phase: 'creating', at: 9500 }
        ],
        environmentCheck: { status: 'passed', startedAt: 6000, finishedAt: 9000 },
        checkoutProgress: { percent: 40, completed: 4, total: 10 }
      },
      10_000
    )
    expect(steps).toEqual([
      {
        id: 'provision',
        state: 'done',
        elapsedMs: 5000,
        percent: null,
        startedAt: 1000,
        skipped: false
      },
      {
        id: 'checks',
        state: 'done',
        elapsedMs: 3000,
        percent: null,
        startedAt: 6000,
        skipped: false
      },
      {
        id: 'create',
        state: 'running',
        elapsedMs: 1000,
        percent: 40,
        startedAt: 9000,
        skipped: false
      }
    ])
  })

  it('marks the workspace step failed, with how long it ran, when creation fails on the VM', () => {
    const steps = deriveVmBuildSteps(
      {
        ...base,
        status: 'error',
        phase: 'fetching',
        phaseLog: [
          { phase: 'provisioning-vm', at: 1000 },
          { phase: 'fetching', at: 4000 }
        ],
        errorAt: 6500,
        environmentCheck: { status: 'passed' }
      },
      9000
    )
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'failed'])
    expect(steps[2].elapsedMs).toBe(2500)
  })

  it('shows skipped checks as skipped, not verified and not stuck pending', () => {
    const steps = deriveVmBuildSteps(
      { ...base, phase: 'fetching', environmentCheck: { status: 'skipped' } },
      5000
    )
    expect(steps[1]).toMatchObject({ state: 'done', skipped: true })
  })

  it('reads as done once the worktree exists and is opening', () => {
    const steps = deriveVmBuildSteps(
      { ...base, phase: 'creating', worktreeId: 'w', environmentCheck: { status: 'passed' } },
      5000
    )
    expect(steps.map((step) => step.state)).toEqual(['done', 'done', 'done'])
  })
})

describe('classifyVmBuildFailure', () => {
  const entry = { phase: 'provisioning-vm' as const }

  it('turns a plan refusal into the plan card, not a recipe failure', () => {
    expect(
      classifyVmBuildFailure({
        entry: { ...entry, errorCode: 'cloudPlanRequired' },
        error: 'x',
        cloud: true
      })
    ).toEqual({ kind: 'plan' })
  })

  it('tells exhausted hours apart from having no plan', () => {
    expect(
      classifyVmBuildFailure({
        entry: {
          ...entry,
          errorCode: 'cloudPlanRequired',
          provisioningLog: '[orca-cloud] provisioning\nOrca Cloud: included_hours_exhausted\n'
        },
        error: 'x',
        cloud: true
      })
    ).toEqual({ kind: 'hoursUsed' })
  })

  it('tells a member limit apart from the team limit, and a spend cap from used hours', () => {
    const refused = (errorCode: string, reason: string) =>
      classifyVmBuildFailure({
        entry: { ...entry, errorCode, provisioningLog: `Orca Cloud: ${reason}\n` },
        error: 'x',
        cloud: true
      })
    expect(refused('cloudConcurrencyLimit', 'member_concurrency_limit')).toEqual({
      kind: 'memberConcurrency'
    })
    expect(refused('cloudConcurrencyLimit', 'concurrency_limit')).toEqual({ kind: 'concurrency' })
    expect(refused('cloudPlanRequired', 'overage_cap_reached')).toEqual({ kind: 'spendCap' })
  })

  it('names a missing snapshot only for Orca Cloud', () => {
    const failed = {
      entry: { ...entry, provisioningLog: 'Error: snapshot snap_1 not found' },
      error: 'Recipe exited with code 1.'
    }
    expect(classifyVmBuildFailure({ ...failed, cloud: true })).toEqual({
      kind: 'snapshotMissing'
    })
    expect(classifyVmBuildFailure({ ...failed, cloud: false })).toEqual({
      kind: 'provision',
      error: 'Recipe exited with code 1.'
    })
  })
})

describe('appendStampedLog', () => {
  it('stamps each line when it starts and drops stamps for trimmed lines', () => {
    const first = appendStampedLog('', [], 'a\nb', 10)
    expect(first.provisioningLogStamps).toEqual([10, 10])
    const second = appendStampedLog(first.provisioningLog, first.provisioningLogStamps, 'c\nd', 20)
    expect(second).toEqual({ provisioningLog: 'a\nbc\nd', provisioningLogStamps: [10, 10, 20] })
    // The last line keeps its first stamp even when its start is trimmed away.
    const long = 'y'.repeat(11_999)
    const trimmed = appendStampedLog(second.provisioningLog, second.provisioningLogStamps, long, 30)
    expect(trimmed.provisioningLogStamps).toEqual([20])
  })
})

describe('holdRunningSteps', () => {
  const quick = { id: 'a', state: 'done' as const, elapsedMs: 100, startedAt: 1000 }
  const next = { id: 'b', state: 'running' as const, elapsedMs: 10, startedAt: 1100 }

  it('holds a step that finished too fast as running and keeps later steps pending', () => {
    const held = holdRunningSteps([quick, next], 1100)
    expect(held.steps.map((step) => step.state)).toEqual(['running', 'pending'])
    expect(held.wakeAt).toBe(1400)
  })

  it('lets a step through once it has shown running long enough', () => {
    expect(holdRunningSteps([quick, next], 1400).steps.map((step) => step.state)).toEqual([
      'done',
      'running'
    ])
  })
})

describe('humanizeOrcaCloudLogLine', () => {
  const t = ((_key: string, fallback: string) => fallback) as Parameters<
    typeof humanizeOrcaCloudLogLine
  >[1]

  it('turns provider codes into sentences and hides internals', () => {
    expect(humanizeOrcaCloudLogLine('Orca Cloud: included_hours_exhausted', t)).toBe(
      'Your team is out of sandbox hours this month.'
    )
    expect(humanizeOrcaCloudLogLine('[orca-cloud] resuming', t)).toBe('Waking the sandbox…')
    expect(humanizeOrcaCloudLogLine('sandbox sbx_41d9 scheduled on pool p-use1-3', t)).toBeNull()
  })
})

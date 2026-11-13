import { describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))

import { appendStampedLog } from '@/lib/workspace/creation/pending-creation-provisioning-log'
import { deriveVmBuildSteps } from './vm-build-steps'
import { classifyVmBuildFailure } from './vm-build-failure'
import { holdRunningSteps } from './use-minimum-running-steps'
import { humanizeOrcaCloudLogLine, provisionStageLabel } from './orca-cloud-build-log'
import { cloneStageLabel, stepLabel } from './vm-build-sheet-copy'
import type { Translate } from '@/i18n/use-translate'

const base = {
  status: 'creating' as const,
  phase: 'provisioning-vm' as const,
  startedAt: 1000,
  phaseLog: [{ phase: 'provisioning-vm' as const, at: 1000 }]
}

describe('deriveVmBuildSteps', () => {
  it('a clone GitHub refused marks the clone failed, not the sandbox start (CLONE-ACCESS-ERROR)', () => {
    const steps = deriveVmBuildSteps(
      {
        ...base,
        status: 'error',
        errorCode: 'cloudCloneFailed',
        errorAt: 3000,
        provisioningLog: 'Orca Cloud: repo_unreachable'
      },
      4000,
      { cloud: true }
    )
    expect(steps.find((step) => step.id === 'provision')?.state).toBe('done')
    expect(steps.find((step) => step.id === 'clone')?.state).toBe('failed')
  })

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

describe('provisionStageLabel (N-01)', () => {
  const t: Translate = (_key, fallback) => fallback

  it('stays quiet for a normal start, then names what the sandbox step waits on', () => {
    const log = '[orca-cloud] provisioning\n'
    expect(
      provisionStageLabel({ phase: 'provisioning-vm', provisioningLog: log }, 4900, t)
    ).toBeNull()
    expect(provisionStageLabel({ phase: 'provisioning-vm', provisioningLog: log }, 5000, t)).toBe(
      'Starting the sandbox…'
    )
    expect(
      provisionStageLabel(
        { phase: 'provisioning-vm', provisioningLog: '[orca-cloud] checking-entitlement\n' },
        5000,
        t
      )
    ).toBe('Checking your plan…')
    expect(provisionStageLabel({ phase: 'preparing' }, 6000, t)).toBe('Getting your project ready…')
    expect(provisionStageLabel({ phase: 'provisioning-vm', provisioningLog: log }, 6000, t)).toBe(
      'Starting the sandbox…'
    )
    expect(
      provisionStageLabel(
        { phase: 'provisioning-vm', provisioningLog: `${log}[orca-cloud] connecting\n` },
        6000,
        t
      )
    ).toBe('Connecting to the sandbox…')
  })
})

describe('Checking your plan… (JA-21)', () => {
  const t: Translate = (_key, fallback) => fallback

  it('says so at once until the server takes the create, then goes quiet as before', () => {
    expect(provisionStageLabel({ phase: 'provisioning-vm', provisioningLog: '' }, 0, t)).toBe(
      'Checking your plan…'
    )
    expect(
      provisionStageLabel(
        { phase: 'provisioning-vm', provisioningLog: '[orca-cloud] checking-entitlement\n' },
        200,
        t
      )
    ).toBe('Checking your plan…')
    expect(
      provisionStageLabel(
        {
          phase: 'provisioning-vm',
          provisioningLog: '[orca-cloud] checking-entitlement\n[orca-cloud] provisioning\n'
        },
        200,
        t
      )
    ).toBeNull()
    expect(provisionStageLabel({ phase: 'preparing', provisioningLog: '' }, 200, t)).toBeNull()
  })
})

describe('humanizeOrcaCloudLogLine', () => {
  const t: Translate = (_key, fallback) => fallback

  it('turns provider codes into sentences and hides internals', () => {
    expect(humanizeOrcaCloudLogLine('Orca Cloud: included_hours_exhausted', t)).toBe(
      'Your team is out of sandbox hours this month.'
    )
    expect(humanizeOrcaCloudLogLine('[orca-cloud] resuming', t)).toBe('Waking the sandbox…')
    expect(humanizeOrcaCloudLogLine('sandbox sbx_41d9 scheduled on pool p-use1-3', t)).toBeNull()
  })
})

describe('Orca Cloud clone step', () => {
  const lines = (...rows: [string, number][]) => ({
    provisioningLog: rows.map(([line]) => `${line}\n`).join(''),
    provisioningLogStamps: rows.map(([, at]) => at)
  })
  const ids = (steps: { id: string }[]) => steps.map((step) => step.id)

  it('runs as its own step with git percent and stage once the sandbox is up', () => {
    const steps = deriveVmBuildSteps(
      {
        ...base,
        ...lines(
          ['[orca-cloud] provisioning', 1000],
          ['[orca-cloud] cloning', 6000],
          ['[orca-cloud] clone-progress 40 download', 9000]
        )
      },
      12_000,
      { cloud: true }
    )
    expect(ids(steps)).toEqual(['provision', 'clone', 'checks', 'create'])
    expect(steps[0]).toMatchObject({ state: 'done', elapsedMs: 5000 })
    expect(steps[1]).toMatchObject({
      state: 'running',
      elapsedMs: 6000,
      percent: 40,
      stage: 'download'
    })
    expect(steps[2]).toMatchObject({ state: 'pending' })
  })

  it('is done with its own time once the next phase starts, failed if the create failed mid-clone', () => {
    const done = deriveVmBuildSteps(
      {
        ...base,
        ...lines(
          ['[orca-cloud] cloning', 6000],
          ['[orca-cloud] clone-progress 95 checkout', 50_000],
          ['[orca-cloud] connecting', 57_000]
        )
      },
      58_000,
      { cloud: true }
    )
    expect(done[1]).toMatchObject({ state: 'done', elapsedMs: 51_000, percent: null })

    const failed = deriveVmBuildSteps(
      {
        ...base,
        status: 'error',
        errorAt: 20_000,
        ...lines(['[orca-cloud] cloning', 6000], ['Orca Cloud: repo_unreachable', 19_000])
      },
      21_000,
      { cloud: true }
    )
    expect(failed[0]).toMatchObject({ state: 'done' })
    expect(failed[1]).toMatchObject({ state: 'failed', elapsedMs: 14_000 })
  })

  it('without clone lines (prebuilt environment) it is done with the sandbox; absent off cloud', () => {
    const steps = deriveVmBuildSteps(
      { ...base, environmentCheck: { status: 'running', startedAt: 6000 } },
      7000,
      { cloud: true }
    )
    expect(steps[1]).toMatchObject({ id: 'clone', state: 'done', elapsedMs: null })
    expect(ids(deriveVmBuildSteps(base, 7000))).toEqual(['provision', 'checks', 'create'])
  })

  it('a clone failure names its cause', () => {
    expect(
      classifyVmBuildFailure({
        entry: {
          phase: 'provisioning-vm',
          errorCode: 'cloudCloneFailed',
          provisioningLog: '[orca-cloud] cloning\nOrca Cloud: clone_timeout\n'
        },
        error: 'x',
        cloud: true
      })
    ).toEqual({ kind: 'cloneFailed', reason: 'clone_timeout' })
  })

  it('names the repository step once, from the boot plan, before it runs (PC-4)', () => {
    const pendingStep = (...rows: [string, number][]) =>
      deriveVmBuildSteps({ ...base, ...lines(...rows) }, 2000, { cloud: true })[1]
    // Not known yet: no mode (the row shows a placeholder, never a guessed label).
    expect(pendingStep(['[orca-cloud] provisioning', 1000])).toMatchObject({
      state: 'pending'
    })
    expect(pendingStep(['[orca-cloud] provisioning', 1000])?.cloneMode).toBeUndefined()
    expect(
      pendingStep(['[orca-cloud] provisioning', 1000], ['[orca-cloud] plan-update', 1200])
    ).toMatchObject({ state: 'pending', cloneMode: 'update' })
    // The running step keeps the planned name.
    const running = deriveVmBuildSteps(
      {
        ...base,
        ...lines(
          ['[orca-cloud] plan-update', 1200],
          ['[orca-cloud] updating', 4000],
          ['[orca-cloud] clone-progress 40 download', 4500]
        )
      },
      5000,
      { cloud: true }
    )[1]
    expect(running).toMatchObject({ state: 'running', cloneMode: 'update' })
  })

  it('a prebuilt repo (environment build) shows as an update, not a clone', () => {
    const t: Translate = (_key, fallback) => fallback
    const steps = deriveVmBuildSteps(
      {
        ...base,
        ...lines(['[orca-cloud] updating', 4000], ['[orca-cloud] clone-progress 40 download', 4500])
      },
      5000,
      { cloud: true }
    )
    expect(steps[1]).toMatchObject({
      id: 'clone',
      state: 'running',
      percent: 40,
      cloneMode: 'update'
    })
    expect(stepLabel(steps[1]!, true, t)).toBe('Update repository')
    expect(cloneStageLabel(steps[1]!.stage, t, steps[1]!.cloneMode)).toBe('Fetching changes…')
    expect(humanizeOrcaCloudLogLine('[orca-cloud] updating', t)).toBe('Updating the repository…')
  })

  it('shows counting (no frozen 0%) until git reports a percent', () => {
    const at = (...extra: [string, number][]) =>
      deriveVmBuildSteps({ ...base, ...lines(['[orca-cloud] cloning', 6000], ...extra) }, 9000, {
        cloud: true
      })[1]
    expect(at()).toMatchObject({ state: 'running', percent: null, stage: 'counting' })
    expect(at(['[orca-cloud] clone-progress 0 download', 7000])).toMatchObject({
      percent: null,
      stage: 'counting'
    })
    expect(at(['[orca-cloud] clone-progress 12 download', 8000])).toMatchObject({
      percent: 12,
      stage: 'download'
    })
  })

  it('progress lines stay out of the plain log', () => {
    const t: Translate = (_key, fallback) => fallback
    expect(humanizeOrcaCloudLogLine('[orca-cloud] cloning', t)).toBe('Cloning the repository…')
    expect(humanizeOrcaCloudLogLine('[orca-cloud] clone-progress 40 download', t)).toBeNull()
  })
})

describe('GitHub-only Orca Cloud create (GH-CREATE-SHEET)', () => {
  it('has no environment checks step: start, clone, then open', () => {
    const log = '[orca-cloud] provisioning\n[orca-cloud] cloning\n[orca-cloud] connecting'
    const steps = deriveVmBuildSteps(
      {
        ...base,
        phase: 'creating',
        phaseLog: [
          { phase: 'provisioning-vm', at: 1000 },
          { phase: 'creating', at: 6000 }
        ],
        provisioningLog: log,
        provisioningLogStamps: [1000, 3000, 5000]
      },
      7000,
      { cloud: true, checks: false }
    )
    expect(steps.map((step) => [step.id, step.state])).toEqual([
      ['provision', 'done'],
      ['clone', 'done'],
      ['create', 'running']
    ])
  })
})

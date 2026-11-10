import { describe, expect, it } from 'vitest'
import {
  deriveCloudSetupSteps,
  getCloudPrimaryAction,
  getOrcaCloudSegmentState,
  getRunOnSegment,
  isCloudSetupPanelVisible,
  resolveDefaultRunOn,
  withReachableGitHub
} from './cloud-start-model'

describe('Run on segment', () => {
  it('maps the committed target to a segment', () => {
    expect(
      getRunOnSegment({
        orcaCloudSelected: true,
        otherRecipeSelected: false,
        selectedHostIsLocal: true
      })
    ).toBe('orca-cloud')
    expect(
      getRunOnSegment({
        orcaCloudSelected: false,
        otherRecipeSelected: true,
        selectedHostIsLocal: true
      })
    ).toBe('other')
    expect(
      getRunOnSegment({
        orcaCloudSelected: false,
        otherRecipeSelected: false,
        selectedHostIsLocal: false
      })
    ).toBe('other')
    expect(
      getRunOnSegment({
        orcaCloudSelected: false,
        otherRecipeSelected: false,
        selectedHostIsLocal: true
      })
    ).toBe('local')
    expect(
      getRunOnSegment({
        orcaCloudSelected: false,
        otherRecipeSelected: false,
        selectedHostIsLocal: null
      })
    ).toBeNull()
  })

  it('keeps Orca Cloud visible but disabled when it cannot be reached (X2)', () => {
    expect(getOrcaCloudSegmentState('unreachable')).toBe('unreachable')
    expect(getOrcaCloudSegmentState('unavailable')).toBe('hidden')
    expect(getOrcaCloudSegmentState('needs-sign-in')).toBe('enabled')
    expect(getOrcaCloudSegmentState('needs-capability')).toBe('enabled')
    expect(getOrcaCloudSegmentState('offered')).toBe('enabled')
  })
})

describe('setup rows and the primary label', () => {
  it('starts directly when the account is entitled', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'entitled', remainingSeconds: 3600 }
    })
    expect(isCloudSetupPanelVisible(steps)).toBe(false)
    expect(getCloudPrimaryAction(steps)).toBe('start')
  })

  it('signed out: one setup trip ("Set up and start"), plan checked after sign-in', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-sign-in',
      access: { state: 'loading' }
    })
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ['account', 'needed'],
      ['plan', 'pending'],
      ['agent', 'optional']
    ])
    expect(isCloudSetupPanelVisible(steps)).toBe(true)
    expect(getCloudPrimaryAction(steps)).toBe('setUpAndStart')
  })

  it('owner without a plan: "Choose plan and start"; lapsed: "Renew and start"', () => {
    const noPlan = deriveCloudSetupSteps({
      availability: 'needs-capability',
      access: { state: 'no-plan', lapsed: false, canManageBilling: true }
    })
    expect(getCloudPrimaryAction(noPlan)).toBe('choosePlanAndStart')
    const lapsed = deriveCloudSetupSteps({
      availability: 'needs-capability',
      access: { state: 'no-plan', lapsed: true, canManageBilling: true }
    })
    expect(getCloudPrimaryAction(lapsed)).toBe('renewAndStart')
  })

  it('a member who cannot fix it gets "Use this computer instead" and no agent row', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-capability',
      access: { state: 'no-plan', lapsed: false, canManageBilling: false }
    })
    expect(steps.some((s) => s.id === 'agent')).toBe(false)
    expect(getCloudPrimaryAction(steps)).toBe('useThisComputer')
    const outOfHours = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'out-of-hours', cause: 'hours', canManageBilling: false }
    })
    expect(getCloudPrimaryAction(outOfHours)).toBe('useThisComputer')
  })

  it('a missing GitHub grant alone reads "Give access and start"', () => {
    expect(
      getCloudPrimaryAction([
        { id: 'account', state: 'done' },
        { id: 'plan', state: 'done' },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ])
    ).toBe('giveAccessAndStart')
  })

  it('a team that can still get its trial just starts (B1); setup grants it with no card', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'no-plan', lapsed: false, canManageBilling: false, trialOfferSeconds: 7200 }
    })
    const plan = steps.find((s) => s.id === 'plan')
    expect(plan).toMatchObject({ need: 'trial', trialSeconds: 7200, canFix: true })
    // Members aren't blocked from the trial: the agent row stays.
    expect(steps.some((s) => s.id === 'agent')).toBe(true)
    expect(getCloudPrimaryAction(steps)).toBe('startTrial')
    // An included trial isn't a task: no panel, the hint line carries it.
    expect(isCloudSetupPanelVisible(steps)).toBe(false)
  })

  it('trial used up: owner "Choose plan and start"; member runs on this computer (T2, C1)', () => {
    const owner = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'no-plan', lapsed: false, canManageBilling: true, trialUsedUp: true }
    })
    expect(owner.find((s) => s.id === 'plan')?.need).toBe('trial-used-up')
    expect(getCloudPrimaryAction(owner)).toBe('choosePlanAndStart')
    const member = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'no-plan', lapsed: false, canManageBilling: false, trialUsedUp: true }
    })
    expect(getCloudPrimaryAction(member)).toBe('useThisComputer')
  })

  it('signed out: the trial row is included and GitHub is checked up front (A1)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-sign-in',
      access: { state: 'signed-out' },
      github: { id: 'github', state: 'needed', need: 'github', canFix: true }
    })
    expect(steps.map((s) => s.id)).toEqual(['account', 'plan', 'github', 'agent'])
    expect(steps.find((s) => s.id === 'plan')?.need).toBe('trial')
    expect(getCloudPrimaryAction(steps)).toBe('setUpAndStart')
  })

  it('GitHub waiting on an owner blocks the start, so ⌘↵ runs locally (D2)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'entitled', remainingSeconds: 3600 },
      github: { id: 'github', state: 'pending', need: 'github', blocksStart: true }
    })
    expect(isCloudSetupPanelVisible(steps)).toBe(true)
    expect(getCloudPrimaryAction(steps)).toBe('useThisComputer')
  })

  it('no GitHub remote outranks account and plan rows (D3)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-sign-in',
      access: { state: 'signed-out' },
      github: { id: 'github', state: 'failed', need: 'github', blocksStart: true }
    })
    expect(steps.map((s) => s.id)).toEqual(['github'])
    expect(getCloudPrimaryAction(steps)).toBe('useThisComputer')
  })

  it('a GitHub check still running holds the start (D1 cache miss)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'entitled', remainingSeconds: 3600 },
      github: { id: 'github', state: 'loading' }
    })
    expect(getCloudPrimaryAction(steps)).toBe('checking')
  })

  it('waits while billing is still being read', () => {
    const steps = deriveCloudSetupSteps({ availability: 'offered', access: { state: 'loading' } })
    expect(getCloudPrimaryAction(steps)).toBe('checking')
  })
})

describe('remembered Run on default', () => {
  it('uses the project, then the global last choice, then this computer', () => {
    expect(
      resolveDefaultRunOn({
        preference: 'last',
        lastForRepo: 'orca-cloud',
        globalLast: 'local',
        cloudUsable: true
      })
    ).toEqual({ target: 'orca-cloud', cloudFellBack: false })
    expect(
      resolveDefaultRunOn({
        preference: 'last',
        lastForRepo: null,
        globalLast: 'orca-cloud',
        cloudUsable: true
      })
    ).toEqual({ target: 'orca-cloud', cloudFellBack: false })
    expect(
      resolveDefaultRunOn({
        preference: 'last',
        lastForRepo: null,
        globalLast: null,
        cloudUsable: true
      })
    ).toEqual({ target: 'local', cloudFellBack: false })
  })

  it('never preselects a blocked Orca Cloud', () => {
    expect(
      resolveDefaultRunOn({
        preference: 'last',
        lastForRepo: 'orca-cloud',
        globalLast: null,
        cloudUsable: false
      })
    ).toEqual({ target: 'local', cloudFellBack: true })
    expect(
      resolveDefaultRunOn({
        preference: 'orca-cloud',
        lastForRepo: null,
        globalLast: null,
        cloudUsable: false
      })
    ).toEqual({ target: 'local', cloudFellBack: true })
  })

  it('a project setting wins over memory', () => {
    expect(
      resolveDefaultRunOn({
        preference: 'local',
        lastForRepo: 'orca-cloud',
        globalLast: 'orca-cloud',
        cloudUsable: true
      })
    ).toEqual({ target: 'local', cloudFellBack: false })
  })
})

describe('withReachableGitHub', () => {
  const session = [
    { id: 'account', state: 'done' },
    { id: 'plan', state: 'done', detail: 'subscription' },
    { id: 'github', state: 'active' }
  ] as const

  it("marks the session's GitHub row done once this desktop reaches the repository", () => {
    expect(withReachableGitHub([...session], true)).toEqual([
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'done', detail: 'subscription' },
      { id: 'github', state: 'done' }
    ])
    expect(getCloudPrimaryAction([...withReachableGitHub([...session], true)])).toBe('start')
  })

  it('leaves the rows alone while the repository is still unreachable', () => {
    const steps = [...session]
    expect(withReachableGitHub(steps, false)).toBe(steps)
  })
})

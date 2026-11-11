import { describe, expect, it } from 'vitest'
import {
  deriveCloudSetupSteps,
  getOrcaCloudSegmentState,
  resolveDefaultRunOn,
  type CloudSetupStep,
  withReachableGitHub
} from './cloud-start-model'
import {
  cloudSetupPageModel,
  cloudSetupRequired,
  sessionNeedsFrom
} from '../../orca-cloud-setup/cloud-setup-page-model'

describe('Orca Cloud availability', () => {
  it('keeps Orca Cloud visible but disabled when it cannot be reached (X2)', () => {
    expect(getOrcaCloudSegmentState('unreachable')).toBe('unreachable')
    expect(getOrcaCloudSegmentState('unavailable')).toBe('hidden')
    expect(getOrcaCloudSegmentState('needs-sign-in')).toBe('enabled')
    expect(getOrcaCloudSegmentState('needs-capability')).toBe('enabled')
    expect(getOrcaCloudSegmentState('offered')).toBe('enabled')
  })
})

describe('setup rows and the setup page', () => {
  const page = (steps: Parameters<typeof cloudSetupPageModel>[0]) =>
    cloudSetupPageModel(steps).action

  it('starts directly when the account is entitled', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'entitled', remainingSeconds: 3600 }
    })
    expect(cloudSetupRequired(steps)).toBe(false)
    expect(page(steps)).toBe('done')
  })

  it('an agent with no account never opens the page (PC-1): the create starts at once', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'entitled', remainingSeconds: 3600 }
    })
    expect(steps.find((s) => s.id === 'agent')?.state).toBe('optional')
    expect(cloudSetupRequired(steps)).toBe(false)
    expect(cloudSetupPageModel(steps).action).toBe('done')
  })

  it('signed out: sign-in first, plan checked after sign-in', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-sign-in',
      access: { state: 'loading' }
    })
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ['account', 'needed'],
      ['plan', 'pending'],
      ['agent', 'optional']
    ])
    expect(page(steps)).toBe('sign-in')
  })

  it('owner without a plan chooses one in the browser; lapsed renews there', () => {
    const noPlan = deriveCloudSetupSteps({
      availability: 'needs-capability',
      access: { state: 'no-plan', lapsed: false, canManageBilling: true }
    })
    expect(page(noPlan)).toBe('choose-plan')
    const lapsed = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'no-plan', lapsed: true, canManageBilling: true }
    })
    expect(page(lapsed)).toBe('choose-plan')
    expect(lapsed.find((s) => s.id === 'plan')?.need).toBe('renew-plan')
  })

  it('a member who cannot fix billing is told to ask an owner, with no agent row', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-capability',
      access: { state: 'no-plan', lapsed: false, canManageBilling: false }
    })
    expect(steps.some((s) => s.id === 'agent')).toBe(false)
    expect(page(steps)).toBe('ask-owner')
    const outOfHours = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'out-of-hours', cause: 'hours', canManageBilling: false }
    })
    expect(page(outOfHours)).toBe('ask-owner')
  })

  it('an owner out of hours fixes it in billing', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'out-of-hours', cause: 'hours', canManageBilling: true }
    })
    expect(page(steps)).toBe('fix-billing')
  })

  it('a missing GitHub grant alone is the GitHub step', () => {
    expect(
      page([
        { id: 'account', state: 'done' },
        { id: 'plan', state: 'done' },
        { id: 'github', state: 'needed', need: 'github', canFix: true },
        { id: 'agent', state: 'optional' }
      ])
    ).toBe('github-install')
  })

  it('a team that can still get its trial claims it in the app (B1)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'no-plan', lapsed: false, canManageBilling: false, trialOfferSeconds: 7200 }
    })
    const plan = steps.find((s) => s.id === 'plan')
    expect(plan).toMatchObject({ need: 'trial', trialSeconds: 7200, canFix: true })
    // Members aren't blocked from the trial: the agent row stays.
    expect(steps.some((s) => s.id === 'agent')).toBe(true)
    expect(page(steps)).toBe('start-trial')
  })

  it('trial used up: owner chooses a plan; member asks an owner (T2, C1)', () => {
    const owner = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'no-plan', lapsed: false, canManageBilling: true, trialUsedUp: true }
    })
    expect(owner.find((s) => s.id === 'plan')?.need).toBe('trial-used-up')
    expect(page(owner)).toBe('choose-plan')
    const member = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'no-plan', lapsed: false, canManageBilling: false, trialUsedUp: true }
    })
    expect(page(member)).toBe('ask-owner')
  })

  it('signed out: the trial row is included and GitHub is checked up front (A1)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-sign-in',
      access: { state: 'signed-out' },
      github: { id: 'github', state: 'needed', need: 'github', canFix: true }
    })
    expect(steps.map((s) => s.id)).toEqual(['account', 'plan', 'github', 'agent'])
    expect(steps.find((s) => s.id === 'plan')?.need).toBe('trial')
    expect(sessionNeedsFrom(steps)).toEqual(['account', 'plan', 'github'])
    expect(page(steps)).toBe('sign-in')
  })

  it('GitHub waiting on an owner: the page waits and starts on its own (D2)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'entitled', remainingSeconds: 3600 },
      github: { id: 'github', state: 'pending', need: 'github', blocksStart: true }
    })
    expect(cloudSetupRequired(steps)).toBe(true)
    expect(page(steps)).toBe('github-waiting')
  })

  it('no GitHub remote outranks account and plan rows (D3)', () => {
    const steps = deriveCloudSetupSteps({
      availability: 'needs-sign-in',
      access: { state: 'signed-out' },
      github: { id: 'github', state: 'failed', need: 'github', blocksStart: true }
    })
    expect(steps.map((s) => s.id)).toEqual(['github'])
    expect(page(steps)).toBe('needs-repository')
  })

  it('checks while GitHub or billing are still being read', () => {
    const github = deriveCloudSetupSteps({
      availability: 'offered',
      access: { state: 'entitled', remainingSeconds: 3600 },
      github: { id: 'github', state: 'loading' }
    })
    expect(page(github)).toBe('checking')
    const billing = deriveCloudSetupSteps({ availability: 'offered', access: { state: 'loading' } })
    expect(page(billing)).toBe('checking')
  })

  it('B2: a team switch is its own step and always opens the page', () => {
    const steps: CloudSetupStep[] = [
      { id: 'account', state: 'done' },
      { id: 'team', state: 'needed' }
    ]
    expect(cloudSetupRequired(steps, { teamSwitch: true })).toBe(true)
    expect(cloudSetupPageModel(steps, { teamSwitch: true }).action).toBe('switch-team')
  })

  it('a still-loading agent row never holds a ready start', () => {
    const steps: CloudSetupStep[] = [
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'done' },
      { id: 'agent', state: 'loading' }
    ]
    expect(cloudSetupRequired(steps)).toBe(false)
    expect(cloudSetupPageModel(steps).action).toBe('done')
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
    expect(cloudSetupPageModel([...withReachableGitHub([...session], true)]).action).toBe('done')
  })

  it('leaves the rows alone while the repository is still unreachable', () => {
    const steps = [...session]
    expect(withReachableGitHub(steps, false)).toBe(steps)
  })
})

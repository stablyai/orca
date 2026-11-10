import { describe, expect, it } from 'vitest'
import {
  deriveCloudSetupSteps,
  getCloudPrimaryAction,
  getOrcaCloudSegmentState,
  getRunOnSegment,
  isCloudSetupPanelVisible,
  resolveDefaultRunOn
} from './cloud-start-model'
import { matchRunOnShortcut } from './RunOnSegmentedControl'

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

  it('matches ⌥⌘1 / ⌥⌘2 on mac and Ctrl+Alt elsewhere', () => {
    const key = (init: {
      code: string
      metaKey?: boolean
      ctrlKey?: boolean
      altKey?: boolean
      shiftKey?: boolean
    }) => ({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      ...init
    })
    expect(matchRunOnShortcut(key({ code: 'Digit1', metaKey: true, altKey: true }), true)).toBe(
      'local'
    )
    expect(matchRunOnShortcut(key({ code: 'Digit2', metaKey: true, altKey: true }), true)).toBe(
      'orca-cloud'
    )
    expect(matchRunOnShortcut(key({ code: 'Digit2', ctrlKey: true, altKey: true }), false)).toBe(
      'orca-cloud'
    )
    expect(matchRunOnShortcut(key({ code: 'Digit2', metaKey: true }), true)).toBeNull()
    expect(
      matchRunOnShortcut(key({ code: 'Digit2', metaKey: true, altKey: true, shiftKey: true }), true)
    ).toBeNull()
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

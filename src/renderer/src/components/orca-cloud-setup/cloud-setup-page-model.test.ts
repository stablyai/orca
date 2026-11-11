import { describe, expect, it } from 'vitest'
import type { CloudSetupStep } from '@/components/new-workspace/run-on/cloud-start-model'
import { actionForStep, cloudSetupPageModel, sessionNeedsFrom } from './cloud-setup-page-model'

describe('cloudSetupPageModel', () => {
  it('walks one step at a time: the first unfinished step is current', () => {
    const steps: CloudSetupStep[] = [
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'needed', need: 'trial', canFix: true, trialSeconds: 7200 },
      { id: 'github', state: 'needed', need: 'github', canFix: true },
      { id: 'agent', state: 'optional' }
    ]
    const model = cloudSetupPageModel(steps)
    expect(model.current?.id).toBe('plan')
    expect(model.action).toBe('start-trial')
    expect(sessionNeedsFrom(steps)).toEqual(['plan', 'github'])
  })

  it('the agent is never a page step and never holds the start (PC-1)', () => {
    const steps: CloudSetupStep[] = [
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'done' },
      { id: 'agent', state: 'optional' }
    ]
    const model = cloudSetupPageModel(steps)
    expect(model.steps.map((step) => step.id)).toEqual(['account', 'team', 'plan', 'github'])
    expect(model).toMatchObject({ current: null, action: 'done' })
  })

  it('always lists Team after Account, like the web (DS-b): done once signed in', () => {
    const signedOut = cloudSetupPageModel([
      { id: 'account', state: 'needed', need: 'sign-in', canFix: true },
      { id: 'plan', state: 'pending', need: 'trial' },
      { id: 'github', state: 'needed', need: 'github', canFix: true }
    ])
    expect(signedOut.steps.map((step) => [step.id, step.state])).toEqual([
      ['account', 'needed'],
      ['team', 'pending'],
      ['plan', 'pending'],
      ['github', 'needed']
    ])
    expect(signedOut.current?.id).toBe('account')
    const signedIn = cloudSetupPageModel([
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'done' },
      { id: 'github', state: 'needed', need: 'github', canFix: true }
    ])
    expect(signedIn.steps.map((step) => [step.id, step.state])).toEqual([
      ['account', 'done'],
      ['team', 'done'],
      ['plan', 'done'],
      ['github', 'needed']
    ])
    expect(signedIn.current?.id).toBe('github')
    // A team switch brings its own Team step: it is kept, not doubled.
    const switching = cloudSetupPageModel(
      [
        { id: 'account', state: 'done' },
        { id: 'team', state: 'needed' },
        { id: 'plan', state: 'done' }
      ],
      { teamSwitch: true }
    )
    expect(switching.steps.map((step) => step.id)).toEqual(['account', 'team', 'plan', 'github'])
    expect(switching.action).toBe('switch-team')
    // No repository (D3): the only row stays the only step.
    expect(
      cloudSetupPageModel([{ id: 'github', state: 'failed', blocksStart: true }]).steps
    ).toHaveLength(1)
  })

  it('always shows all four web steps; an unknown one is pending and never current (DS-b)', () => {
    // Re-run repro 1: signed out, the GitHub row isn't known yet.
    const signedOut = cloudSetupPageModel([
      { id: 'account', state: 'needed', need: 'sign-in', canFix: true },
      { id: 'plan', state: 'pending', need: 'trial' },
      { id: 'agent', state: 'optional' }
    ])
    expect(signedOut.steps.map((step) => [step.id, step.state])).toEqual([
      ['account', 'needed'],
      ['team', 'pending'],
      ['plan', 'pending'],
      ['github', 'pending']
    ])
    expect(signedOut.current?.id).toBe('account')
    // Re-run repro 2: a member with no active team, on "Switch to your team": no Plan row.
    const switching = cloudSetupPageModel(
      [
        { id: 'account', state: 'done' },
        { id: 'team', state: 'needed' },
        { id: 'github', state: 'needed', need: 'github', canFix: true }
      ],
      { teamSwitch: true }
    )
    expect(switching.steps.map((step) => [step.id, step.state])).toEqual([
      ['account', 'done'],
      ['team', 'needed'],
      ['plan', 'pending'],
      ['github', 'needed']
    ])
    expect(switching).toMatchObject({ current: { id: 'team' }, action: 'switch-team' })
    // A placeholder never holds a start: everything known is done → done, even with GitHub unknown.
    const unknownRepo = cloudSetupPageModel([
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'done' }
    ])
    expect(unknownRepo.steps.map((step) => step.id)).toEqual(['account', 'team', 'plan', 'github'])
    expect(unknownRepo).toMatchObject({ current: null, action: 'done' })
  })

  it('maps each blocker to its one action', () => {
    expect(actionForStep({ id: 'plan', state: 'pending', need: 'trial' })).toBe('sign-in')
    expect(actionForStep({ id: 'plan', state: 'needed', need: 'payment', canFix: true })).toBe(
      'fix-billing'
    )
    expect(actionForStep({ id: 'plan', state: 'needed', need: 'plan', canFix: false })).toBe(
      'ask-owner'
    )
    expect(actionForStep({ id: 'team', state: 'needed' }, { teamSwitch: true })).toBe('switch-team')
    expect(actionForStep({ id: 'github', state: 'loading' })).toBe('checking')
  })
})

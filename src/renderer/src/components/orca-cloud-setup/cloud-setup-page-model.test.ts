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

  it('a skipped agent finishes setup', () => {
    const steps: CloudSetupStep[] = [
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'done' },
      { id: 'agent', state: 'optional' }
    ]
    expect(cloudSetupPageModel(steps).action).toBe('agent')
    expect(cloudSetupPageModel(steps, { agentSkipped: true })).toMatchObject({
      current: null,
      action: 'done'
    })
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

describe('page settles before it starts', () => {
  it('a still-loading agent row reads Checking, not All set', () => {
    const steps: CloudSetupStep[] = [
      { id: 'account', state: 'done' },
      { id: 'plan', state: 'done' },
      { id: 'agent', state: 'loading' }
    ]
    expect(cloudSetupPageModel(steps).action).toBe('checking')
  })
})

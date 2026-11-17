import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { cloudStartAgentStep } from './cloud-start-agent-step'
import type { CloudSetupStep } from './cloud-start-model'

const STEP: CloudSetupStep = { id: 'agent', state: 'optional' }

describe('cloudStartAgentStep', () => {
  it('is done and reads the source when the agent is covered', () => {
    expect(
      cloudStartAgentStep(STEP, { kind: 'covered', agent: 'claude', via: 'account' }, translate)
    ).toEqual({ id: 'agent', state: 'done', detail: 'Claude · from your Orca account' })
    expect(
      cloudStartAgentStep(STEP, { kind: 'covered', agent: 'codex', via: 'team' }, translate)
    ).toMatchObject({ state: 'done', detail: 'Codex · team key' })
  })

  it('offers Set up once when nothing covers it, and never blocks Start', () => {
    const step = cloudStartAgentStep(STEP, { kind: 'notSetUp', agent: 'claude' }, translate)
    expect(step).toMatchObject({
      state: 'optional',
      detail:
        'Claude isn’t set up for Orca Cloud yet. Set it up once in Settings → Cloud agent sign-ins.',
      action: { label: 'Set up once' }
    })
    expect(step?.blocksStart).toBeUndefined()
  })

  it('is info only under the kill switch, has no action signed out, and hides when asked', () => {
    expect(
      cloudStartAgentStep(STEP, { kind: 'killSwitch', agent: 'claude' }, translate)
    ).toMatchObject({
      detail: 'Claude signs in for each cloud workspace while Orca account sign-in is paused.'
    })
    expect(
      cloudStartAgentStep(STEP, { kind: 'killSwitch', agent: 'claude' }, translate)?.action
    ).toBeUndefined()
    const signedOut = cloudStartAgentStep(STEP, { kind: 'signedOut', agent: 'claude' }, translate)
    expect(signedOut?.action).toBeUndefined()
    expect(signedOut?.status).toBe('Optional')
    expect(cloudStartAgentStep(STEP, { kind: 'hidden' }, translate)).toBeNull()
    expect(cloudStartAgentStep(STEP, { kind: 'loading', agent: 'claude' }, translate)?.state).toBe(
      'loading'
    )
  })
})

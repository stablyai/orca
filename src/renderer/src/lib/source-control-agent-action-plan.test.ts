import { describe, expect, it } from 'vitest'
import {
  planSourceControlAgentActionLaunch,
  resolveSourceControlAgentAvailability
} from './source-control-agent-action-plan'
import type { CustomTuiAgent, GlobalSettings } from '../../../shared/types'

const CUSTOM_ID = 'custom-agent:codex:11111111-1111-4111-8111-111111111111'

function customAgent(overrides: Partial<CustomTuiAgent> = {}): CustomTuiAgent {
  return {
    id: CUSTOM_ID,
    baseAgent: 'codex',
    label: 'My Codex',
    args: '',
    env: {},
    syncEnv: false,
    ...overrides
  }
}

function settings(overrides: Partial<GlobalSettings> = {}): Partial<GlobalSettings> {
  return {
    customTuiAgents: [],
    deletedCustomTuiAgents: [],
    agentCmdOverrides: {},
    agentDefaultEnv: {},
    ...overrides
  }
}

describe('resolveSourceControlAgentAvailability', () => {
  it('resolves a stock built-in to itself, baseline-detection', () => {
    expect(resolveSourceControlAgentAvailability('claude', settings())).toEqual({
      baseAgent: 'claude',
      availabilityClass: 'baseline-detection'
    })
  })

  it('marks a built-in with a configured executable override launch-reported', () => {
    expect(
      resolveSourceControlAgentAvailability(
        'claude',
        settings({ agentCmdOverrides: { claude: '/opt/claude' } })
      )
    ).toEqual({ baseAgent: 'claude', availabilityClass: 'launch-reported' })
  })

  it('marks a built-in with agent env launch-reported', () => {
    expect(
      resolveSourceControlAgentAvailability(
        'claude',
        settings({ agentDefaultEnv: { claude: { API_KEY: 'x' } } })
      )
    ).toEqual({ baseAgent: 'claude', availabilityClass: 'launch-reported' })
  })

  it('resolves a plain custom agent to its base, baseline-detection', () => {
    expect(
      resolveSourceControlAgentAvailability(
        CUSTOM_ID,
        settings({ customTuiAgents: [customAgent()] })
      )
    ).toEqual({ baseAgent: 'codex', availabilityClass: 'baseline-detection' })
  })

  it('marks a custom agent with a command override launch-reported', () => {
    expect(
      resolveSourceControlAgentAvailability(
        CUSTOM_ID,
        settings({ customTuiAgents: [customAgent({ commandOverride: 'my-codex' })] })
      )
    ).toEqual({ baseAgent: 'codex', availabilityClass: 'launch-reported' })
  })

  it('marks a custom agent with env launch-reported', () => {
    expect(
      resolveSourceControlAgentAvailability(
        CUSTOM_ID,
        settings({ customTuiAgents: [customAgent({ env: { TOKEN: 'y' } })] })
      )
    ).toEqual({ baseAgent: 'codex', availabilityClass: 'launch-reported' })
  })

  it('returns a null base for an unknown custom id', () => {
    expect(resolveSourceControlAgentAvailability(CUSTOM_ID, settings())).toEqual({
      baseAgent: null,
      availabilityClass: 'baseline-detection'
    })
  })
})

describe('planSourceControlAgentActionLaunch', () => {
  it('rejects disabled agents', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'codex',
        baseAgent: 'codex',
        availabilityClass: 'baseline-detection',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex'],
        disabledAgents: ['codex']
      })
    ).toEqual({ ok: false, error: 'The selected agent is disabled in Settings.' })
  })

  it('rejects an unresolvable base (deleted/unknown custom id)', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: CUSTOM_ID,
        baseAgent: null,
        availabilityClass: 'baseline-detection',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex']
      })
    ).toEqual({ ok: false, error: 'The selected agent was not detected on this workspace host.' })
  })

  it('rejects a baseline-detection agent whose base is not detected', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'claude',
        baseAgent: 'claude',
        availabilityClass: 'baseline-detection',
        commandInput: 'Fix checks',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex']
      })
    ).toEqual({ ok: false, error: 'The selected agent was not detected on this workspace host.' })
  })

  it('never blocks a launch-reported agent whose base is not detected', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: CUSTOM_ID,
      baseAgent: 'codex',
      availabilityClass: 'launch-reported',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: []
    })
    expect(result.ok).toBe(true)
  })

  it('keys delivery off the resolved base for a custom id without crashing', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: CUSTOM_ID,
      baseAgent: 'codex',
      availabilityClass: 'baseline-detection',
      commandInput: 'Fix checks',
      promptDelivery: 'submit-after-ready',
      detectedAgents: ['codex']
    })
    expect(result.ok && result.delivery).toBe('paste-submit')
    expect(result.ok && result.deliveryLabel).toContain('Pasted and submitted')
    expect(result.ok && result.summary).toContain('pastes and submits')
    expect(result.ok && result.caveat).toContain('PATH')
  })

  it('describes native-draft delivery for a base with a prefill flag', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'claude',
      baseAgent: 'claude',
      availabilityClass: 'baseline-detection',
      commandInput: 'Fix checks',
      promptDelivery: 'draft',
      detectedAgents: ['claude']
    })
    expect(result.ok && result.delivery).toBe('draft-native')
    expect(result.ok && result.deliveryLabel).toContain('editable draft')
  })

  it('falls back to draft-paste for a base without native draft', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'aider',
      baseAgent: 'aider',
      availabilityClass: 'baseline-detection',
      commandInput: 'Fix checks',
      promptDelivery: 'draft',
      detectedAgents: ['aider']
    })
    expect(result.ok && result.delivery).toBe('draft-paste')
  })

  it('uses argv delivery for an argv base on auto-submit', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'claude',
      baseAgent: 'claude',
      availabilityClass: 'baseline-detection',
      commandInput: 'Fix checks',
      promptDelivery: 'auto-submit',
      detectedAgents: ['claude']
    })
    expect(result.ok && result.delivery).toBe('argv')
  })

  it('uses draft-paste for a stdin-after-start base on auto-submit', () => {
    const result = planSourceControlAgentActionLaunch({
      agent: 'aider',
      baseAgent: 'aider',
      availabilityClass: 'baseline-detection',
      commandInput: 'Fix checks',
      promptDelivery: 'auto-submit',
      detectedAgents: ['aider']
    })
    expect(result.ok && result.delivery).toBe('draft-paste')
  })

  it('rejects an empty command input', () => {
    expect(
      planSourceControlAgentActionLaunch({
        agent: 'codex',
        baseAgent: 'codex',
        availabilityClass: 'baseline-detection',
        commandInput: '   ',
        promptDelivery: 'submit-after-ready',
        detectedAgents: ['codex']
      })
    ).toEqual({ ok: false, error: 'Command input is empty.' })
  })
})

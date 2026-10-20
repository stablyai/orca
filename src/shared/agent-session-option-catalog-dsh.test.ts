import { describe, expect, it } from 'vitest'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'

describe('DSH launch-only options', () => {
  it('uses native session flags and overrides configured flags without changing defaults', () => {
    const settings = { agentDefaultArgs: { dsh: '--model old/default --effort low' } }
    const original = structuredClone(settings)
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'dsh',
      settings,
      platform: 'linux',
      isRemote: false,
      shell: undefined,
      sessionOptions: { model: 'ark/kimi3', effort: 'provider-custom' }
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
    expect(plan?.launchCommand).toBe("dsh-tui . '--model' 'ark/kimi3' '--effort' 'provider-custom'")
    expect(plan?.sessionOptions).toEqual({ model: 'ark/kimi3', effort: 'provider-custom' })
    expect(settings).toEqual(original)
    expect(getAgentSessionOptionCatalog('dsh')).toBeNull()
  })

  it('preserves distinct parallel session selections and lets DSH validate model-specific effort', () => {
    const first = checkAgentLaunchModelPreferences({
      agent: 'dsh',
      model: 'ark/kimi3',
      effort: 'high'
    })
    const second = checkAgentLaunchModelPreferences({
      agent: 'dsh',
      model: 'ark/deepseek-flash',
      effort: 'provider-custom'
    })
    expect(first).toEqual({ preferences: { model: 'ark/kimi3', effort: 'high' } })
    expect(second).toEqual({
      preferences: { model: 'ark/deepseek-flash', effort: 'provider-custom' }
    })
    expect(checkAgentLaunchModelPreferences({ agent: 'dsh', effort: 'high' })).toMatchObject({
      refusal: { code: 'invalid_argument' }
    })
  })
})

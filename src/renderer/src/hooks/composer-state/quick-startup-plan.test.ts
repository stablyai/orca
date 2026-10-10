import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildQuickComposerStartup, type QuickComposerStartupInput } from './quick-startup-plan'

function input(overrides: Partial<QuickComposerStartupInput>): QuickComposerStartupInput {
  return {
    agent: 'claude',
    prompt: '',
    draftPrompt: null,
    settings: { ...getDefaultSettings('/tmp'), agentDefaultArgs: { claude: '--model haiku' } },
    platform: 'linux',
    shell: null,
    isRemote: false,
    telemetrySource: 'sidebar',
    ...overrides
  }
}

describe('buildQuickComposerStartup', () => {
  it('launches with a plugin task’s model and effort over the default arguments', () => {
    const { startupPlan } = buildQuickComposerStartup(
      input({ sessionOptionOverrides: { model: 'opus', effort: 'high' } })
    )
    expect(startupPlan?.launchCommand).toContain("'--model' 'opus'")
    expect(startupPlan?.launchCommand).not.toContain('haiku')
    expect(startupPlan?.sessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })

  it('keeps the options on a launch that types a draft prompt', () => {
    const { startupPlan } = buildQuickComposerStartup(
      input({ draftPrompt: 'Implement the plan.', sessionOptionOverrides: { model: 'opus' } })
    )
    expect(startupPlan?.launchCommand).toContain("'--model' 'opus'")
    expect(startupPlan?.sessionOptions).toEqual({ model: 'opus' })
  })

  it('adds no session options when the launch names none', () => {
    const { startupPlan } = buildQuickComposerStartup(input({}))
    expect(startupPlan?.launchCommand).toContain("'--model' 'haiku'")
    expect(startupPlan?.sessionOptions).toBeUndefined()
  })
})

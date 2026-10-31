import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('Freebuff startup', () => {
  it('keeps Freebuff command overrides separate from Codebuff', () => {
    const cmdOverrides = { freebuff: 'freebuff --debug' }
    const freebuff = buildAgentStartupPlan({
      agent: 'freebuff',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides,
      platform: 'linux',
      isRemote: true
    })
    const codebuff = buildAgentStartupPlan({
      agent: 'codebuff',
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides,
      platform: 'linux',
      isRemote: true
    })

    expect(freebuff).toMatchObject({
      launchCommand: 'freebuff --debug',
      expectedProcess: 'freebuff',
      followupPrompt: null
    })
    expect(codebuff).toMatchObject({ launchCommand: 'codebuff', expectedProcess: 'codebuff' })
  })
})

import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('Freebuff startup', () => {
  it.each([
    ['darwin', 'posix', false],
    ['linux', 'posix', false],
    ['win32', 'powershell', false],
    ['win32', 'cmd', false],
    ['linux', 'posix', true]
  ] as const)('delivers prompts after launch on %s/%s (remote=%s)', (platform, shell, isRemote) => {
    const prompt = 'Review "quoted paths"; $(echo task)\nThen explain the changes.'
    const plan = buildAgentStartupPlan({
      agent: 'freebuff',
      prompt,
      cmdOverrides: { codebuff: 'codebuff --debug' },
      platform,
      shell,
      isRemote
    })

    expect(plan).toMatchObject({
      agent: 'freebuff',
      launchCommand: 'freebuff',
      expectedProcess: 'freebuff',
      followupPrompt: prompt
    })
  })

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

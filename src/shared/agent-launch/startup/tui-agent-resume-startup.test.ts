import { expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { buildAgentResumeStartupPlan } from './tui-agent-resume-startup'

it('resumes a slept Claude agent on the model it was launched with, once, beside its session effort', () => {
  const launched = buildAgentStartupPlan({
    agent: 'claude',
    prompt: 'Coordinate',
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    sessionOptions: { model: 'claude-opus-5-5[1m]', effort: 'medium' }
  })
  expect(launched?.launchCommand).toContain('--model')

  const resumed = buildAgentResumeStartupPlan({
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'conversation-1', effort: 'medium' },
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    ...launched!.launchConfig
  })
  const command = resumed!.launchCommand
  expect(command.match(/--model/g)).toHaveLength(1)
  expect(command).toContain("'claude-opus-5-5[1m]'")
  expect(command.match(/--effort/g)).toHaveLength(1)
  expect(command).toMatch(/'?--resume'? '?conversation-1'?$/)
})

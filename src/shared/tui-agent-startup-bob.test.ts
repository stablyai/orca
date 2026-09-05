import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('IBM Bob startup plans', () => {
  it('launches the IBM Bob chat UI and injects the prompt after startup', () => {
    // Why: Bob Shell 2.x has no interactive initial-prompt flag; `--trust` skips the
    // first-launch trust menu that would otherwise swallow the injected paste.
    const plan = buildAgentStartupPlan({
      agent: 'bob',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toEqual({
      agent: 'bob',
      launchCommand: 'bob chat --trust',
      expectedProcess: 'bob',
      followupPrompt: 'fix it',
      launchConfig: { agentCommand: 'bob chat --trust', agentArgs: '', agentEnv: {} }
    })
  })

  it('appends yolo args after the chat subcommand', () => {
    // Why: `--auto-approve` is a `bob chat` option; top-level `bob --auto-approve` is fatal.
    const plan = buildAgentStartupPlan({
      agent: 'bob',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '--auto-approve',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toMatch(/^bob chat --trust '?--auto-approve'?$/)
  })
})

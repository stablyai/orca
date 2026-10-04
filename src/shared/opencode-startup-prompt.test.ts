import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan, buildAgentDraftLaunchPlan } from './tui-agent-startup'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_SHELL_ENV
} from './opencode-startup-prompt'

describe('native OpenCode startup submission intent', () => {
  it('binds the exact trimmed native prompt to host-selectable transport', () => {
    const plan = buildAgentStartupPlan({
      agent: 'opencode',
      prompt: '  task\nwith unicode é  ',
      cmdOverrides: {},
      platform: 'linux'
    })
    expect(plan?.env).toEqual({
      [OPENCODE_STARTUP_PROMPT_SHA256_ENV]: createHash('sha256')
        .update('task\nwith unicode é')
        .digest('hex'),
      [OPENCODE_STARTUP_PROMPT_BODY_ENV]: 'task\nwith unicode é',
      [OPENCODE_STARTUP_PROMPT_SHELL_ENV]: 'posix'
    })
    expect(plan?.launchCommand).toContain('--prompt')
  })

  it('preserves explicit run commands without a submission intent', () => {
    const plan = buildAgentStartupPlan({
      agent: 'opencode',
      prompt: 'task',
      cmdOverrides: { opencode: 'opencode --log-level debug run' },
      platform: 'linux'
    })
    expect(plan?.env).toBeUndefined()
    expect(plan?.launchCommand).toContain('run --prompt')
  })

  it('never gives an editable draft or empty launch an automatic submission intent', () => {
    const args = { agent: 'opencode' as const, cmdOverrides: {}, platform: 'linux' as const }
    expect(
      buildAgentDraftLaunchPlan({ ...args, draft: 'draft' })?.env?.[
        OPENCODE_STARTUP_PROMPT_SHA256_ENV
      ]
    ).toBeUndefined()
    expect(
      buildAgentStartupPlan({ ...args, prompt: '', allowEmptyPromptLaunch: true })?.env?.[
        OPENCODE_STARTUP_PROMPT_SHA256_ENV
      ]
    ).toBeUndefined()
  })
})

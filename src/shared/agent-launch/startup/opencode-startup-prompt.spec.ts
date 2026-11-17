import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from './tui-agent-startup'
import {
  OPENCODE_STARTUP_PROMPT_SHA256_ENV,
  OPENCODE_STARTUP_PROMPT_BODY_ENV,
  OPENCODE_STARTUP_PROMPT_SHELL_ENV
} from './opencode-startup-prompt'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

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

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'keeps run and its flags before a positional message in %s',
    (shell) => {
      for (const agent of ['opencode', 'opencode2'] as const) {
        const prompt = '--literal task with unicode é'
        const plan = buildAgentStartupPlan({
          agent,
          prompt,
          cmdOverrides: { [agent]: 'opencode --log-level debug run --standalone' },
          platform: shell === 'posix' ? 'linux' : 'win32',
          shell,
          agentEnv: { CUSTOM_CONFIG: 'kept' }
        })
        expect(plan).not.toBeNull()
        const parsed = tokenizeStartupCommand(plan?.launchCommand ?? '', shell)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) {
          throw new Error(parsed.error)
        }
        expect(parsed.tokens).toEqual([
          'opencode',
          '--log-level',
          'debug',
          'run',
          '--standalone',
          '--',
          prompt
        ])
        expect(plan?.env).toEqual({ CUSTOM_CONFIG: 'kept' })
        expect(plan?.followupPrompt).toBeNull()
      }
    }
  )

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'reuses an existing run message separator in %s',
    (shell) => {
      const plan = buildAgentStartupPlan({
        agent: 'opencode',
        prompt: '--literal task',
        cmdOverrides: { opencode: 'opencode run --standalone --' },
        platform: shell === 'posix' ? 'linux' : 'win32',
        shell
      })
      const parsed = tokenizeStartupCommand(plan?.launchCommand ?? '', shell)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      expect(parsed.tokens).toEqual(['opencode', 'run', '--standalone', '--', '--literal task'])
      expect(plan?.env).toBeUndefined()
    }
  )
})

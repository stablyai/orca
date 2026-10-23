import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan, buildAgentDraftLaunchPlan } from './tui-agent-startup'
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

  it('preserves explicit run commands without a submission intent', () => {
    const plan = buildAgentStartupPlan({
      agent: 'opencode',
      prompt: 'task',
      cmdOverrides: { opencode: 'opencode --log-level debug run' },
      platform: 'linux'
    })
    expect(plan?.env).toBeUndefined()
    expect(plan?.launchCommand).toContain("run -- 'task'")
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

describe('wrapped OpenCode run startup', () => {
  it.each(['opencode', 'opencode2'] as const)(
    'keeps %s run flags and positional task behind POSIX prefixes',
    (agent) => {
      for (const command of [
        'CUSTOM_CONFIG=private opencode run --standalone',
        'env CUSTOM_CONFIG=private opencode run --standalone',
        'env -- CUSTOM_CONFIG=private opencode run --standalone',
        'env -- CUSTOM_CONFIG=private opencode run --standalone --',
        'env CUSTOM_CONFIG=private opencode run --title "--"'
      ]) {
        const plan = buildAgentStartupPlan({
          agent,
          prompt: '--literal task',
          cmdOverrides: { [agent]: command },
          platform: 'linux',
          shell: 'posix',
          isRemote: true,
          agentEnv: { CUSTOM_CONFIG: 'kept' }
        })
        expect(plan?.launchCommand).toBe(
          command.endsWith(' --') ? `${command} '--literal task'` : `${command} -- '--literal task'`
        )
        expect(plan?.env).toEqual({ CUSTOM_CONFIG: 'kept' })
        expect(plan?.followupPrompt).toBeNull()
      }
    }
  )

  it.each(['opencode', 'opencode2'] as const)(
    'preserves %s PowerShell call syntax and its run separator',
    (agent) => {
      for (const separator of ['', ' --']) {
        const command = `& "C:\\Program Files\\opencode\\opencode.exe" --log-level debug run --standalone${separator}`
        const plan = buildAgentStartupPlan({
          agent,
          prompt: "--task's é",
          cmdOverrides: { [agent]: command },
          platform: 'win32',
          shell: 'powershell',
          agentEnv: { CUSTOM_CONFIG: 'kept' }
        })
        expect(plan?.launchCommand).toBe(`${command}${separator ? ' ' : ' -- '}'--task''s é'`)
        expect(plan?.env).toEqual({ CUSTOM_CONFIG: 'kept' })
        expect(plan?.followupPrompt).toBeNull()
      }
    }
  )
})

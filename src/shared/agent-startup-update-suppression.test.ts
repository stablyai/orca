import { describe, expect, it } from 'vitest'
import type { TuiAgent } from './tui-agent'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

const ENV_CASES = [
  { agent: 'claude', env: { DISABLE_AUTOUPDATER: '1' } },
  { agent: 'claude-agent-teams', env: { DISABLE_AUTOUPDATER: '1' } },
  { agent: 'opencode', env: { OPENCODE_DISABLE_AUTOUPDATE: 'true' } },
  { agent: 'opencode2', env: { OPENCODE_DISABLE_AUTOUPDATE: 'true' } },
  { agent: 'antigravity', env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' } },
  { agent: 'grok', env: { GROK_DISABLE_AUTOUPDATER: '1' } },
  { agent: 'pi', env: { PI_SKIP_VERSION_CHECK: '1' } },
  { agent: 'kimi', env: { KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' } }
] satisfies { agent: TuiAgent; env: Record<string, string> }[]

describe('unattended agent startup updates', () => {
  it.each(ENV_CASES)(
    'suppresses $agent only in the initial environment and preserves configured values for resume',
    ({ agent, env }) => {
      const agentEnv = {
        KEEP: 'a value with spaces',
        ...Object.fromEntries(Object.keys(env).map((key) => [key, '0']))
      }
      const input = {
        agent,
        agentEnv,
        prompt: 'Run the automation',
        cmdOverrides: {},
        platform: 'linux' as const
      }
      const ordinary = buildAgentStartupPlan(input)
      const unattended = buildAgentStartupPlan({ ...input, suppressStartupUpdatePrompt: true })
      expect(unattended).not.toBeNull()
      expect(unattended?.env).toEqual({ ...ordinary?.env, ...env })
      expect(ordinary?.env).toMatchObject(agentEnv)
      expect(unattended?.launchConfig).toEqual(ordinary?.launchConfig)
      expect(unattended?.launchConfig.agentEnv).toEqual(agentEnv)
      expect(agentEnv.KEEP).toBe('a value with spaces')
    }
  )

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'quotes launch-only flags for %s without saving them for resume',
    (shell) => {
      const cases = [
        { agent: 'codex', flags: ['-c', 'check_for_update_on_startup=false'] },
        { agent: 'aider', flags: ['--no-check-update', '--no-show-release-notes'] },
        { agent: 'cursor', flags: ['--disable-auto-update'] }
      ] satisfies { agent: TuiAgent; flags: string[] }[]
      for (const { agent, flags } of cases) {
        const input = {
          agent,
          prompt: "Review today's changes",
          cmdOverrides: {},
          platform: 'win32' as const,
          shell
        }
        const ordinary = buildAgentStartupPlan(input)
        const unattended = buildAgentStartupPlan({ ...input, suppressStartupUpdatePrompt: true })
        const parsed = tokenizeStartupCommand(unattended?.launchCommand ?? '', shell)
        expect(parsed.ok).toBe(true)
        if (!parsed.ok) {
          throw new Error(parsed.error)
        }
        for (const flag of flags) {
          expect(parsed.tokens).toContain(flag)
        }
        expect(unattended?.launchConfig).toEqual(ordinary?.launchConfig)
        expect(unattended?.followupPrompt).toBe(ordinary?.followupPrompt)
      }
    }
  )

  it('does not invent controls for a CLI without a verified launch override', () => {
    const input = {
      agent: 'gemini' as const,
      prompt: '',
      allowEmptyPromptLaunch: true,
      cmdOverrides: {},
      platform: 'linux' as const
    }
    expect(buildAgentStartupPlan({ ...input, suppressStartupUpdatePrompt: true })).toEqual(
      buildAgentStartupPlan(input)
    )
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'keeps Aider suppression after configured switches and before positional files in %s',
    (shell) => {
      const input = {
        agent: 'aider' as const,
        prompt: 'Review the files',
        cmdOverrides: {},
        platform: 'win32' as const,
        shell,
        agentArgs: '--check-update --show-release-notes -- notes.md'
      }
      const ordinary = buildAgentStartupPlan(input)
      const unattended = buildAgentStartupPlan({ ...input, suppressStartupUpdatePrompt: true })
      const parsed = tokenizeStartupCommand(unattended?.launchCommand ?? '', shell)
      if (!parsed.ok) {
        throw new Error(parsed.error)
      }
      expect(parsed.tokens).toEqual([
        'aider',
        '--check-update',
        '--show-release-notes',
        '--no-check-update',
        '--no-show-release-notes',
        '--',
        'notes.md'
      ])
      expect(unattended?.launchConfig).toEqual(ordinary?.launchConfig)
    }
  )
})

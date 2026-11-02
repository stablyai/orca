import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { AgentLaunchSettingsMutation } from './rpc-contract/agent-launch-settings-params'
import { buildAgentStartupPlan, buildAgentResumeStartupPlan } from './tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  tuiAgentArgsBypassPermissions
} from './tui-agent-launch-defaults'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import { buildAgentRecipeFreshLaunch } from './tui-agent-resume-startup'

describe('automatic terminal permissions', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)(
    'sends the automatic mode through a fresh launch and resume on %s',
    (shell) => {
      const platform = shell === 'posix' ? 'linux' : 'win32'
      const mutation = AgentLaunchSettingsMutation.parse({ type: 'permissions', mode: 'auto' })
      const settings = agentLaunchSettingsMutationUpdates({}, mutation, platform)

      for (const agent of ['claude', 'claude-agent-teams', 'codex'] as const) {
        const agentArgs = resolveTuiAgentLaunchArgs(agent, settings)
        const startup = buildAgentStartupPlan({
          agent,
          agentArgs,
          prompt: '',
          cmdOverrides: {},
          platform,
          shell,
          isRemote: true,
          allowEmptyPromptLaunch: true
        })
        expect(startup).not.toBeNull()
        expect(startup?.launchConfig.agentArgs).toBe(agentArgs)
        expect(tokenizeStartupCommand(startup?.launchCommand ?? '', shell)).toMatchObject({
          ok: true,
          tokens: expect.arrayContaining(
            agent === 'codex' ? ['--approve-for-me'] : ['--permission-mode', 'auto']
          )
        })
        expect(tuiAgentArgsBypassPermissions(agent, agentArgs, shell)).toBe(false)

        if (agent === 'claude-agent-teams') {
          continue
        }
        const resumed = buildAgentResumeStartupPlan({
          agent,
          ...startup?.launchConfig,
          providerSession: { key: 'session_id', id: 'saved-session' },
          cmdOverrides: {},
          platform,
          shell,
          isRemote: true
        })
        if (agent === 'codex') {
          // Codex restores the thread's own saved permissions on resume.
          expect(resumed?.launchConfig.agentArgs).toBe('')
          expect(tokenizeStartupCommand(resumed?.launchCommand ?? '', shell)).toMatchObject({
            ok: true,
            tokens: [
              'codex',
              ...(shell === 'posix' ? ['-c', 'disable_paste_burst=true'] : []),
              'resume',
              'saved-session'
            ]
          })
          continue
        }
        expect(resumed?.launchConfig.agentArgs).toBe(agentArgs)
        expect(tokenizeStartupCommand(resumed?.launchCommand ?? '', shell)).toMatchObject({
          ok: true,
          tokens: expect.arrayContaining(['--permission-mode', 'auto'])
        })
      }
    }
  )
})

describe('codex resume permissions', () => {
  it.each(['posix', 'powershell', 'cmd'] as const)(
    "drops Orca's full-access flag from a recorded %s launch but keeps the user's args",
    (shell) => {
      const platform = shell === 'posix' ? 'linux' : 'win32'
      const startup = buildAgentStartupPlan({
        agent: 'codex',
        agentArgs: "--dangerously-bypass-approvals-and-sandbox -m gpt-5.5 --add-dir 'my dir'",
        prompt: '',
        cmdOverrides: { codex: 'my-codex' },
        platform,
        shell,
        allowEmptyPromptLaunch: true
      })
      const resume = (fork: boolean) =>
        buildAgentResumeStartupPlan({
          agent: 'codex',
          ...startup?.launchConfig,
          providerSession: { key: 'session_id', id: 'saved-session' },
          cmdOverrides: {},
          platform,
          shell,
          fork
        })
      expect(tokenizeStartupCommand(resume(false)?.launchCommand ?? '', shell)).toMatchObject({
        ok: true,
        tokens: ['my-codex', '-m', 'gpt-5.5', '--add-dir', 'my dir', 'resume', 'saved-session']
      })
      expect(resume(false)?.launchConfig.agentArgs).toBe("-m gpt-5.5 --add-dir 'my dir'")
      // A fork starts a new thread, so it keeps the recorded launch's permission.
      expect(resume(true)?.launchCommand).toContain('--dangerously-bypass-approvals-and-sandbox')
    }
  )
})

describe('a fresh restart of a resumed Codex pane', () => {
  const platform = 'linux'
  const shell = 'posix'
  const providerSession = { key: 'session_id' as const, id: 'saved-session' }
  const textSettings = agentLaunchSettingsMutationUpdates(
    {},
    AgentLaunchSettingsMutation.parse({ type: 'permissions', mode: 'auto' }),
    platform
  )
  const typedSettings = { agentPermissionDefault: 'auto' as const }
  const tokens = (command: string | undefined) => {
    const parsed = tokenizeStartupCommand(command ?? '', shell)
    return parsed.ok ? parsed.tokens : []
  }

  it.each([
    ['flag text', textSettings],
    ['a typed choice', typedSettings]
  ])(
    'gets back the permission its resume dropped when settings store it as %s',
    (_label, settings) => {
      const startup = buildAgentStartupPlan({
        agent: 'codex',
        agentArgs: resolveTuiAgentLaunchArgs('codex', settings),
        prompt: '',
        cmdOverrides: {},
        platform,
        shell,
        allowEmptyPromptLaunch: true
      })
      const resumed = buildAgentResumeStartupPlan({
        agent: 'codex',
        ...startup?.launchConfig,
        providerSession,
        cmdOverrides: {},
        platform,
        shell
      })
      expect(tokens(resumed?.launchCommand)).not.toContain('--approve-for-me')
      const fresh = buildAgentRecipeFreshLaunch({
        agent: 'codex',
        ...resumed?.launchConfig,
        cmdOverrides: {},
        platform,
        shell,
        permissionSettings: settings
      })
      expect(tokens(fresh?.command)).toContain('--approve-for-me')
      expect(tokens(fresh?.command)).not.toContain('resume')
    }
  )

  it('keeps a permission the recipe names over the current setting', () => {
    const bypass = '--dangerously-bypass-approvals-and-sandbox'
    const fresh = buildAgentRecipeFreshLaunch({
      agent: 'codex',
      agentCommand: `codex ${bypass}`,
      agentArgs: bypass,
      cmdOverrides: {},
      platform,
      shell,
      permissionSettings: typedSettings
    })
    expect(tokens(fresh?.command)).toContain(bypass)
    expect(tokens(fresh?.command)).not.toContain('--approve-for-me')
  })
})

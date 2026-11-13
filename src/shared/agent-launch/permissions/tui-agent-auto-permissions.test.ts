import { describe, expect, it } from 'vitest'

import { buildAgentStartupPlan } from '../startup/tui-agent-startup'
import { buildAgentResumeStartupPlan } from '../startup/tui-agent-resume-startup'

import { tokenizeStartupCommand } from '../startup/tui-agent-startup-shell'

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

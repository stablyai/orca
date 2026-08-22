// Resume-plan cases, split out of tui-agent-startup.test.ts to keep both files
// inside the max-lines budget. Same subject: the argv a resumed agent launches with.

import { describe, expect, it } from 'vitest'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import { RESUMABLE_TUI_AGENTS } from './agent-session-resume'
import { getTuiAgentLaunchCommand, TUI_AGENT_CONFIG } from './tui-agent-config'

describe('tui agent resume startup plans', () => {
  it('builds Windows resume plans that PowerShell can invoke', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      platform: 'win32',
      agentStatusHookSettings: null
    })

    expect(plan?.launchCommand).toBe("codex 'resume' 's1'")
  })

  it('quotes Windows resume argv for cmd.exe when shell is cmd', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'grok',
      providerSession: { key: 'session_id', id: '019fc272-80fa-7a91-80a2-9c461ef1a9da' },
      cmdOverrides: {},
      agentArgs: '--permission-mode bypassPermissions',
      platform: 'win32',
      shell: 'cmd',
      agentStatusHookSettings: null
    })

    // Why: cmd.exe treats single quotes as literal characters. Resume must use
    // double quotes (or unquoted tokens) so the CLI receives clean argv.
    expect(plan?.launchCommand).toBe(
      'grok "--permission-mode" "bypassPermissions" "--resume" "019fc272-80fa-7a91-80a2-9c461ef1a9da"'
    )
  })

  it('keeps cmd-quoted agentCommand aligned with cmd resume suffix', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'grok',
      providerSession: { key: 'session_id', id: '019fc272-80fa-7a91-80a2-9c461ef1a9da' },
      cmdOverrides: {},
      agentCommand: 'grok "--permission-mode" "bypassPermissions"',
      platform: 'win32',
      shell: 'cmd',
      agentStatusHookSettings: null
    })

    // Regression: agentCommand from a prior cmd launch + PowerShell-default resume
    // suffix produced mixed quoting and broke reboot restore on cmd.exe tabs.
    expect(plan?.launchCommand).toBe(
      'grok "--permission-mode" "bypassPermissions" "--resume" "019fc272-80fa-7a91-80a2-9c461ef1a9da"'
    )
  })

  it('honors command overrides when building POSIX resume plans', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: { codex: 'codex --profile work' },
      platform: 'linux',
      agentStatusHookSettings: null
    })

    expect(plan?.launchCommand).toBe("codex --profile work 'resume' 's1'")
  })

  it('uses a captured launch command when building resume plans after overrides change', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: { codex: 'codex --profile changed' },
      agentCommand: 'codex --profile captured',
      platform: 'linux',
      agentStatusHookSettings: null
    })

    expect(plan?.launchCommand).toBe("codex --profile captured 'resume' 's1'")
    expect(plan?.launchConfig).toEqual({
      agentCommand: 'codex --profile captured',
      agentArgs: '',
      agentEnv: {}
    })
  })

  it('keeps an AI Vault OMP file locator separate from provider identity', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'omp',
      providerSession: { key: 'session_id', id: 'omp-session-1' },
      cmdOverrides: {},
      ompResumeFilePath: '/custom/root/project/session.jsonl',
      platform: 'linux',
      agentStatusHookSettings: null
    })

    expect(plan?.launchCommand).toBe("omp '--resume' '/custom/root/project/session.jsonl'")
    expect(plan?.launchConfig).toEqual({
      agentCommand: 'omp',
      agentArgs: '',
      agentEnv: {},
      ompResumeFilePath: '/custom/root/project/session.jsonl'
    })
  })

  // Why this is pinned: wiring `isRemote` into the resume paths (#11941) makes
  // it reach two consumers — the Codex hooks override, which is the point, and
  // `getTuiAgentLaunchCommand`, which drops the local-only `orca-ide` rename on
  // Linux. The second is unreachable here: `launchCmdByPlatform` is declared by
  // exactly one agent, `claude-agent-teams`, and that agent is not resumable.
  // If someone adds `launchCmdByPlatform` to a resumable agent, or makes
  // claude-agent-teams resumable, a remote resume would silently start emitting
  // a different binary name and process recognition would be the thing that
  // notices. This turns that into a failing test instead.
  it.each(RESUMABLE_TUI_AGENTS)(
    'resolves the same Linux launch binary remote or local for %s',
    (agent) => {
      const config = TUI_AGENT_CONFIG[agent]
      expect(getTuiAgentLaunchCommand(config, 'linux', { isRemote: true })).toBe(
        getTuiAgentLaunchCommand(config, 'linux', { isRemote: false })
      )
    }
  )
})

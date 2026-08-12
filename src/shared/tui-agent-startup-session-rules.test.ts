import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from './tui-agent-startup'

describe('agent session rules file injection', () => {
  it('appends --append-system-prompt-file for claude startup plans', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesFilePath: '/tmp/orca-agent-session-rules-abc.md'
    })

    expect(plan?.launchCommand).toContain(
      "claude --append-system-prompt-file '/tmp/orca-agent-session-rules-abc.md' 'fix it'"
    )
    expect(plan?.launchCommand).toContain("rm -f -- '/tmp/orca-agent-session-rules-abc.md'")
    expect(plan?.launchCommand.indexOf('rm -f --')).toBeGreaterThan(
      plan?.launchCommand.indexOf("'fix it'") ?? -1
    )
  })

  it('omits the flag when no rules file path is given', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("claude 'fix it'")
  })

  it('ignores agentSessionRulesFilePath for agents with no sessionRulesFileFlag', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesFilePath: '/tmp/orca-agent-session-rules-abc.md'
    })

    expect(plan?.launchCommand).toBe("codex 'fix it'")
  })

  it('appends the rules flag before --prefill in claude draft launch plans', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'claude',
      draft: 'prefill text',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesFilePath: '/tmp/orca-agent-session-rules-abc.md'
    })

    expect(plan?.launchCommand).toContain(
      "claude --append-system-prompt-file '/tmp/orca-agent-session-rules-abc.md' --prefill 'prefill text'"
    )
    expect(plan?.launchCommand).toContain("rm -f -- '/tmp/orca-agent-session-rules-abc.md'")
  })

  it('appends the rules flag to claude resume plans without baking it into launchConfig', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'claude',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesFilePath: '/tmp/orca-agent-session-rules-abc.md'
    })

    expect(plan?.launchCommand).toContain(
      "claude --append-system-prompt-file '/tmp/orca-agent-session-rules-abc.md' '--resume' 's1'"
    )
    expect(plan?.launchCommand).toContain("rm -f -- '/tmp/orca-agent-session-rules-abc.md'")
    expect(plan?.launchConfig).toEqual({
      agentCommand: 'claude',
      agentArgs: '',
      agentEnv: {}
    })
  })

  it.each([
    ['claude', "claude --append-system-prompt 'follow graph' 'fix it'"],
    ['openclaude', "openclaude --append-system-prompt 'follow graph' 'fix it'"],
    ['pi', "pi --append-system-prompt 'follow graph' 'fix it'"],
    ['omp', "omp --append-system-prompt 'follow graph' 'fix it'"],
    ['droid', "droid --append-system-prompt 'follow graph' 'fix it'"]
  ] as const)('injects inline system rules for %s', (agent, expected) => {
    const plan = buildAgentStartupPlan({
      agent,
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesText: 'follow graph'
    })

    expect(plan?.launchCommand).toBe(expected)
  })

  it('injects Codex rules through a per-session developer_instructions override', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesText: 'follow graph'
    })

    expect(plan?.launchCommand).toBe(`codex -c 'developer_instructions="follow graph"' 'fix it'`)
  })

  it('inserts native rule options before an agent-argument terminator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '-- forwarded',
      platform: 'linux',
      agentSessionRulesText: 'follow graph'
    })

    expect(plan?.launchCommand).toBe(
      `codex -c 'developer_instructions="follow graph"' '--' 'forwarded' 'fix it'`
    )
  })

  it('falls back to a labeled startup-prompt prefix for agents without a native rules channel', () => {
    const plan = buildAgentStartupPlan({
      agent: 'gemini',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesText: 'follow graph'
    })

    expect(plan?.launchCommand).toBe(
      "gemini --prompt-interactive '## Agent session rules\n\nfollow graph\n\n## User request\n\nfix it'"
    )
  })

  it('delivers cmd.exe rules after startup instead of placing arbitrary text on the command line', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'cmd',
      agentSessionRulesText: 'first line\r\nsecond line & %PATH%'
    })

    expect(plan?.launchCommand).toBe('claude')
    expect(plan?.followupPrompt).toBe(
      '## Agent session rules\n\nfirst line\r\nsecond line & %PATH%\n\n## User request\n\nfix it'
    )
  })

  it('moves oversized native rule text out of argv and into post-ready delivery', () => {
    const rules = `follow graph ${'x'.repeat(8_000)}`
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'powershell',
      agentSessionRulesText: rules
    })

    expect(plan?.launchCommand).toBe('codex')
    expect(plan?.followupPrompt).toContain(rules)
    expect(plan?.followupPrompt).toContain('## User request\n\nfix it')
  })

  it('treats an unknown remote Windows shell as unsafe for inline rule text', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'win32',
      isRemote: true,
      agentSessionRulesText: 'follow graph & keep %PATH% literal'
    })

    expect(plan?.launchCommand).toBe('codex')
    expect(plan?.followupPrompt).toContain('follow graph & keep %PATH% literal')
  })

  it('prefers a rules file over duplicate inline injection when both are available', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesFilePath: '/tmp/rules.md',
      agentSessionRulesText: 'follow graph'
    })

    expect(plan?.launchCommand).toContain(
      "claude --append-system-prompt-file '/tmp/rules.md' 'fix it'"
    )
    expect(plan?.launchCommand).toContain("rm -f -- '/tmp/rules.md'")
  })

  it('uses Auggie native rules-file support', () => {
    const plan = buildAgentStartupPlan({
      agent: 'aug',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux',
      agentSessionRulesFilePath: '/tmp/rules.md'
    })

    expect(plan?.launchCommand).toContain("auggie --rules '/tmp/rules.md'")
    expect(plan?.launchCommand).toContain("rm -f -- '/tmp/rules.md'")
    expect(plan?.followupPrompt).toBe('fix it')
  })
})

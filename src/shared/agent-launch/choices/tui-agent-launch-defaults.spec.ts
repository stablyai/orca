import { describe, expect, it } from 'vitest'
import {
  resolvedTuiAgentArgsBypassPermissions,
  tuiAgentArgsBypassPermissions
} from './tui-agent-launch-defaults'

describe('tuiAgentArgsBypassPermissions', () => {
  // Legacy Yolo intent lives in Arguments, not separate storage; recognize its token sequence anywhere before --.
  it.each([
    ['claude', '--dangerously-skip-permissions', true],
    ['claude', '--dangerously-skip-permissions --model Opus', true],
    ['claude', '--model Opus --dangerously-skip-permissions', true],
    ['claude', '', false],
    ['claude', '--model Opus', false],
    // A token boundary, so a longer flag that merely starts the same way is not a bypass.
    ['claude', '--dangerously-skip-permissions-not-really', false],
    [
      'claude',
      '--append-system-prompt "mention --dangerously-skip-permissions only as text"',
      false
    ],
    ['claude', '-- --dangerously-skip-permissions', false],
    ['codex', '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol', true],
    ['codex', '--model gpt-5.6-sol', false],
    ['codex', '--config "note=--dangerously-bypass-approvals-and-sandbox only as text"', false],
    ['codex', '-- --dangerously-bypass-approvals-and-sandbox', false],
    // Two-token bypass flags match as a token sequence, not one token.
    ['grok', '--permission-mode bypassPermissions', true],
    ['grok', '--model grok-4.7 --permission-mode bypassPermissions', true],
    ['grok', '--permission-mode default', false],
    ['grok', '--permission-mode', false],
    ['grok', '--permission-mode "bypassPermissions now"', false],
    ['grok', '-- --permission-mode bypassPermissions', false],
    ['devin', '--permission-mode bypass --respect-workspace-trust false', true],
    ['devin', '--permission-mode bypass', false]
  ] as const)('reads %s args %s as %s', (agent, args, expected) => {
    expect(tuiAgentArgsBypassPermissions(agent, args, 'posix')).toBe(expected)
  })

  it('uses the configured local Windows shell family', () => {
    expect(
      resolvedTuiAgentArgsBypassPermissions(
        'claude',
        {
          agentDefaultArgs: { claude: '`--dangerously-skip-permissions' },
          terminalWindowsShell: 'powershell.exe'
        },
        'win32'
      )
    ).toBe(true)
    expect(
      resolvedTuiAgentArgsBypassPermissions(
        'codex',
        {
          agentDefaultArgs: { codex: '^--dangerously-bypass-approvals-and-sandbox' },
          terminalWindowsShell: 'cmd.exe'
        },
        'win32'
      )
    ).toBe(true)
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'does not authorize quoted text or operands after -- on %s',
    (shell) => {
      expect(
        tuiAgentArgsBypassPermissions(
          'codex',
          '--config "note=--dangerously-bypass-approvals-and-sandbox only as text"',
          shell
        )
      ).toBe(false)
      expect(
        tuiAgentArgsBypassPermissions(
          'codex',
          '-- --dangerously-bypass-approvals-and-sandbox',
          shell
        )
      ).toBe(false)
    }
  )
})

describe('resolvedTuiAgentArgsBypassPermissions', () => {
  it('fails closed when the configured arguments cannot be tokenized', () => {
    expect(
      resolvedTuiAgentArgsBypassPermissions(
        'codex',
        { agentDefaultArgs: { codex: '"--dangerously-bypass-approvals-and-sandbox' } },
        'linux'
      )
    ).toBe(false)
  })
})

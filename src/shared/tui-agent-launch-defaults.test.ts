import { describe, expect, it } from 'vitest'
import {
  resolvedTuiAgentArgsBypassPermissions,
  resolveTuiAgentLaunchArgs,
  tuiAgentArgsBypassPermissions
} from './tui-agent-launch-defaults'
import { applyAgentPermissionMode, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { isTuiAgent } from './tui-agent-config'

describe('tuiAgentArgsBypassPermissions', () => {
  // The Agent Permissions toggle has no storage of its own: Yolo is the presence of the agent's
  // bypass flag in the arguments string, wherever the user has written the rest of the field.
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

  it('reads no bypass out of an absent or non-string value', () => {
    expect(tuiAgentArgsBypassPermissions('claude', null, 'posix')).toBe(false)
    expect(tuiAgentArgsBypassPermissions('claude', undefined, 'posix')).toBe(false)
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
  // The settings shape the Agent Permissions toggle writes, for every agent it covers.
  it.each(Object.keys(YOLO_TUI_AGENT_ARGS).filter(isTuiAgent))(
    "reads the toggle's own Yolo and Manual writes for %s",
    (agent) => {
      for (const platform of ['darwin', 'win32'] as const) {
        const yolo = applyAgentPermissionMode({ mode: 'yolo' })
        expect(resolvedTuiAgentArgsBypassPermissions(agent, yolo, platform)).toBe(true)
        const manual = applyAgentPermissionMode({ mode: 'manual' })
        expect(resolvedTuiAgentArgsBypassPermissions(agent, manual, platform)).toBe(false)
      }
    }
  )

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

describe('resolveTuiAgentLaunchArgs', () => {
  // A terminal launch still applies the whole configured string verbatim; only the structured
  // route stopped reading it.
  it('hands the configured arguments to a terminal launch unchanged', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        claude: '--dangerously-skip-permissions --model Opus'
      })
    ).toBe('--dangerously-skip-permissions --model Opus')
  })

  it('falls back to the agent default when nothing is configured', () => {
    expect(resolveTuiAgentLaunchArgs('claude', {})).toBe('--dangerously-skip-permissions')
    expect(resolveTuiAgentLaunchArgs('claude', { claude: '' })).toBe('')
  })
})

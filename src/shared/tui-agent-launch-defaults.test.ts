import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDefaultEnv,
  resolvedTuiAgentArgsBypassPermissions,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  tuiAgentArgsBypassPermissions
} from './tui-agent-launch-defaults'

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
    ['codex', '-- --dangerously-bypass-approvals-and-sandbox', false]
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

describe('Grok launch privacy defaults', () => {
  it('opts Orca-launched Grok out of trace upload by default', () => {
    expect(getTuiAgentDefaultEnv('grok')).toEqual({
      GROK_TELEMETRY_TRACE_UPLOAD: '0'
    })
    expect(resolveTuiAgentLaunchEnv('grok', undefined)).toEqual({
      GROK_TELEMETRY_TRACE_UPLOAD: '0'
    })
    // Other agents' configured env does not block Grok defaults.
    expect(resolveTuiAgentLaunchEnv('grok', { goose: { GOOSE_MODE: 'auto' } })).toEqual({
      GROK_TELEMETRY_TRACE_UPLOAD: '0'
    })
  })

  it('honors an explicit empty or custom Grok agentDefaultEnv override', () => {
    expect(resolveTuiAgentLaunchEnv('grok', { grok: {} })).toEqual({})
    expect(
      resolveTuiAgentLaunchEnv('grok', {
        grok: { GROK_TELEMETRY_TRACE_UPLOAD: '1', GROK_HOME: '/tmp/g' }
      })
    ).toEqual({ GROK_TELEMETRY_TRACE_UPLOAD: '1', GROK_HOME: '/tmp/g' })
  })
})

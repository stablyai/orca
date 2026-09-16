import { describe, expect, it } from 'vitest'
import {
  resolveTuiAgentLaunchArgs,
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
    ['codex', '--dangerously-bypass-approvals-and-sandbox --model gpt-5.6-sol', true],
    ['codex', '--model gpt-5.6-sol', false]
  ] as const)('reads %s args %s as %s', (agent, args, expected) => {
    expect(tuiAgentArgsBypassPermissions(agent, args)).toBe(expected)
  })

  it('reads no bypass out of an absent or non-string value', () => {
    expect(tuiAgentArgsBypassPermissions('claude', null)).toBe(false)
    expect(tuiAgentArgsBypassPermissions('claude', undefined)).toBe(false)
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

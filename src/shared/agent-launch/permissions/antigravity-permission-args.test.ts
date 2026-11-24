import { describe, expect, it } from 'vitest'
import { findOptionOccurrence } from '../../cli/command-option-occurrence'
import { agentRequiredValueOptions } from '../../agent-session/options/launch/agent-session-option-agent-args'
import { newChatPermissionModeForSettings } from './agent-chat-permission-mode'
import { agentPermissionArgsForLaunch, optionName } from './agent-permission-args'
import { liftAgentPermissionArgs } from './tui-agent-permission-lift'

describe('Antigravity Approve-for-Me permission boundary', () => {
  it('injects --mode auto when auto permission is active and no conflicting flag is present', () => {
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '--model gemini-2.5-pro')).toBe(
      '--mode auto'
    )
  })

  it.each([
    ['--mode plan'],
    ['-mode plan'],
    ['-mode=accept-edits'],
    ['--dangerously-skip-permissions'],
    ['-dangerously-skip-permissions']
  ])('suppresses --mode auto when user args already pass %s', (userArgs) => {
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', userArgs)).toBeNull()
  })

  it('keeps Go single-dash -mode intact instead of slicing to -m', () => {
    expect(optionName('antigravity', '-mode')).toBe('-mode')
    expect(optionName('antigravity', '-mode=auto')).toBe('-mode')
  })

  it('lifts --mode auto to auto permission mode while preserving Go alias -mode auto', () => {
    expect(liftAgentPermissionArgs('antigravity', '--model pro --mode auto')).toEqual({
      choice: 'auto',
      args: '--model pro'
    })
    expect(liftAgentPermissionArgs('antigravity', '-mode auto --effort high')).toEqual({
      choice: null,
      args: '-mode auto --effort high'
    })
  })

  it('consumes -mode value token in agentRequiredValueOptions', () => {
    const match = findOptionOccurrence(
      ['-mode', 'auto', '--model', 'pro'],
      ['-mode', '--mode'],
      true,
      agentRequiredValueOptions('antigravity')
    )
    expect(match).toEqual({
      index: 0,
      consumed: 2,
      value: 'auto'
    })
  })

  it('keeps new Antigravity chats on ask when saved terminal permission is auto', () => {
    expect(
      newChatPermissionModeForSettings('antigravity', { agentPermissionDefault: 'auto' })
    ).toBe('ask')
  })
})

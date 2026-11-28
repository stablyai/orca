import { describe, expect, it } from 'vitest'
import { findOptionOccurrence } from '../../cli/command-option-occurrence'
import { agentRequiredValueOptions } from '../../agent-session/options/launch/agent-session-option-agent-args'
import { sourceControlActionPermissionModeRoute } from '../../source-control/ai/recipes/source-control-action-options'
import { agentPickerPermissions } from '../picker/agent-launch-picker-catalog'
import { resolveAgentLaunchCommand } from '../startup/tui-agent-launch-command'
import { buildAgentStartupPlan } from '../startup/tui-agent-startup'
import { newChatPermissionModeForSettings } from './agent-chat-permission-mode'
import { agentPermissionArgsForLaunch, optionName } from './agent-permission-args'
import { applyAllAgentsPermission } from './tui-agent-permission-choice'
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

  it('consumes -mode and --i value tokens in agentRequiredValueOptions', () => {
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
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '--i --mode')).toBe('--mode auto')
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '-p --mode')).toBe('--mode auto')
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '--print --mode')).toBe(
      '--mode auto'
    )
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '--prompt --mode')).toBe(
      '--mode auto'
    )
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '-r --mode')).toBe('--mode auto')
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '--resume --mode')).toBe(
      '--mode auto'
    )
    expect(agentPermissionArgsForLaunch('antigravity', 'auto', '--settings --mode')).toBe(
      '--mode auto'
    )
  })

  it('retains --mode auto in resumeLaunch configuration', () => {
    const resolved = resolveAgentLaunchCommand({
      agent: 'antigravity',
      cmdOverrides: {},
      platform: 'darwin',
      shell: 'posix',
      agentArgs: null,
      sessionOptions: { permissionMode: 'auto', model: 'pro' }
    })
    expect(resolved.ok).toBe(true)
    if (resolved.ok) {
      expect(resolved.command).toBe("agy '--model' 'pro' '--mode' 'auto'")
      expect(resolved.resumeLaunch.agentCommand).toBe("agy '--model' 'pro' '--mode' 'auto'")
    }
  })

  it('keeps new Antigravity chats on ask when saved terminal permission is auto', () => {
    expect(
      newChatPermissionModeForSettings('antigravity', { agentPermissionDefault: 'auto' })
    ).toBe('ask')
  })

  it.each([
    ['posix', 'darwin', "agy '--model' 'pro' '--mode' 'auto'"],
    ['powershell', 'win32', "agy '--model' 'pro' '--mode' 'auto'"],
    ['cmd', 'win32', 'agy "--model" "pro" "--mode" "auto"']
  ] as const)(
    'builds terminal startup plan with --mode auto under %s shell',
    (shell, platform, expectedCommand) => {
      const permissionArgs = agentPermissionArgsForLaunch('antigravity', 'auto', '--model pro')
      const plan = buildAgentStartupPlan({
        agent: 'antigravity',
        prompt: '',
        cmdOverrides: {},
        platform,
        shell,
        allowEmptyPromptLaunch: true,
        agentArgs: ['--model pro', permissionArgs].filter(Boolean).join(' ')
      })
      expect(plan?.launchCommand).toBe(expectedCommand)
    }
  )

  it('includes antigravity in global auto permission and excludes auto from chat picker', () => {
    const applied = applyAllAgentsPermission({}, 'auto')
    expect(applied.agentPermissionDefault).toBe('auto')
    expect(applied.agentPermissionOverrides?.antigravity).toBeUndefined()

    expect(agentPickerPermissions('antigravity', 'terminal')).toContain('auto')
    expect(agentPickerPermissions('antigravity', 'chat')).not.toContain('auto')
    expect(sourceControlActionPermissionModeRoute('antigravity', 'auto')).toBe('terminals')
  })
})

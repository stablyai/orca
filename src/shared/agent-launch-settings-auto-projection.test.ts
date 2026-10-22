import { describe, expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings
} from './agent-launch-settings'
import { applyAgentPermissionMode, AUTO_TUI_AGENT_ARGS } from './tui-agent-permissions'

describe('agent launch permission projection compatibility', () => {
  it('publishes Auto through an optional marker alongside the existing Mixed value', () => {
    const settings = projectAgentLaunchSettings(applyAgentPermissionMode({ mode: 'auto' }))
    expect(settings.permissionMode).toBe('mixed')
    expect(settings.autoPermissionMode).toBe(true)
    expect(settings.agentDefaultArgs.codex).toBe('--approve-for-me')
    expect(settings.agentDefaultArgs.claude).toBe('--permission-mode auto')
  })

  it.each(['yolo', 'manual'] as const)('preserves the existing %s projection', (mode) => {
    const settings = projectAgentLaunchSettings(applyAgentPermissionMode({ mode }))
    expect(settings.permissionMode).toBe(mode)
    expect(settings).not.toHaveProperty('autoPermissionMode')
  })

  it('does not label a partly configured automatic profile as Auto', () => {
    const settings = projectAgentLaunchSettings({ agentDefaultArgs: { codex: '--approve-for-me' } })
    expect(settings.permissionMode).toBe('mixed')
    expect(settings).not.toHaveProperty('autoPermissionMode')
  })

  it('publishes the mode of agents Auto does not cover, never Auto itself', () => {
    const yolo = applyAgentPermissionMode({ mode: 'yolo' })
    const settings = projectAgentLaunchSettings(applyAgentPermissionMode({ mode: 'auto', ...yolo }))
    expect(settings.nonAutoPermissionMode).toBe('yolo')
    const manual = projectAgentLaunchSettings(applyAgentPermissionMode({ mode: 'auto' }))
    expect(manual.nonAutoPermissionMode).toBe('manual')
  })

  it('keeps one custom agent from making the profile mixed', () => {
    const yolo = applyAgentPermissionMode({ mode: 'yolo' })
    const settings = projectAgentLaunchSettings({
      ...yolo,
      agentDefaultArgs: { ...yolo.agentDefaultArgs, codex: '--model gpt-5' }
    })
    expect(settings.permissionMode).toBe('yolo')
  })

  it('changes only agents Auto does not cover', () => {
    const automatic = applyAgentPermissionMode({
      mode: 'auto',
      ...applyAgentPermissionMode({ mode: 'yolo' })
    })
    const updates = agentLaunchSettingsMutationUpdates(
      automatic,
      { type: 'permissions', mode: 'manual', exceptAuto: true },
      'darwin'
    )
    expect(updates.agentDefaultArgs).toMatchObject(AUTO_TUI_AGENT_ARGS)
    expect(updates.agentDefaultArgs?.gemini).toBe('')
    expect(() =>
      agentLaunchSettingsMutationUpdates(
        automatic,
        { type: 'permissions', mode: 'auto', exceptAuto: true },
        'darwin'
      )
    ).toThrow()
  })
})

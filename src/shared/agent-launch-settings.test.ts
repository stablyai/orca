import { describe, expect, it } from 'vitest'
import {
  agentLaunchSettingsMutationUpdates,
  projectAgentLaunchSettings
} from './agent-launch-settings'
import { YOLO_TUI_AGENT_ARGS, YOLO_TUI_AGENT_ENV } from './tui-agent-permissions'

describe('agent launch settings', () => {
  it('keeps the global permission selection when an agent has custom arguments', () => {
    const settings = {
      agentDefaultArgs: { ...YOLO_TUI_AGENT_ARGS, codex: '--model gpt-5' },
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    }

    expect(projectAgentLaunchSettings(settings)).toMatchObject({
      permissionMode: 'yolo',
      permissionHasCustomOverrides: true
    })

    const updates = agentLaunchSettingsMutationUpdates(
      settings,
      { type: 'permissions', mode: 'manual' },
      'win32'
    )
    expect(projectAgentLaunchSettings({ ...settings, ...updates })).toMatchObject({
      permissionMode: 'manual',
      permissionHasCustomOverrides: true
    })
  })
})

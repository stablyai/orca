import { describe, expect, it } from 'vitest'
import { agentLaunchSettingsMutationUpdates } from './agent-launch-settings'
import { applyAgentPermissionMode, AUTO_TUI_AGENT_ARGS } from './tui-agent-permissions'

describe('agent launch permission projection compatibility', () => {
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
    ).toThrow('Auto cannot apply to agents without automatic permission review')
  })
})

import { describe, expect, it } from 'vitest'
import { projectAgentLaunchSettings } from './agent-launch-settings'

describe('projectAgentLaunchSettings disabledTuiAgentsCustomized', () => {
  it('keeps a hidden list saved before the marker existed as the host choice', () => {
    expect(
      projectAgentLaunchSettings({ disabledTuiAgents: ['codex'] }, 'linux')
        .disabledTuiAgentsCustomized
    ).toBe(true)
    expect(
      projectAgentLaunchSettings({ disabledTuiAgents: [] }, 'linux').disabledTuiAgentsCustomized
    ).toBe(false)
  })
})

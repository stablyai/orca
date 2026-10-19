import { describe, expect, it } from 'vitest'
import { buildDefaultAgentSettingsUpdate } from './default-agent-settings'

describe('default agent settings', () => {
  it.each(['blank', 'claude', null] as const)(
    'clears the retired setup-only flag for %s',
    (agent) => {
      expect(buildDefaultAgentSettingsUpdate(agent)).toEqual({
        defaultTuiAgent: agent,
        newWorkspaceSetupOnly: false
      })
    }
  )
})

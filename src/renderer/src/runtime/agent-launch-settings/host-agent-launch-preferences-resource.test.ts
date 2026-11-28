import { describe, expect, it } from 'vitest'
import {
  effectiveAgentLaunchPreferences,
  type AgentLaunchPreferences
} from './host-agent-launch-preferences-resource'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

const desktop: AgentLaunchPreferences = { defaultTuiAgent: null, disabledTuiAgents: ['codex'] }
const owner = {
  environmentId: 'env-1',
  pairingRevision: getRuntimeEnvironmentRevision('env-1'),
  runtimeId: undefined
}

describe('effectiveAgentLaunchPreferences', () => {
  it('uses the desktop hidden agents until the host list is set', () => {
    const host = {
      defaultTuiAgent: null,
      disabledTuiAgents: [],
      disabledTuiAgentsCustomized: false
    }
    expect(effectiveAgentLaunchPreferences(owner, desktop, host).disabledTuiAgents).toEqual([
      'codex'
    ])
  })

  it('lets a deliberately empty host list win once set', () => {
    const host = { defaultTuiAgent: null, disabledTuiAgents: [], disabledTuiAgentsCustomized: true }
    expect(effectiveAgentLaunchPreferences(owner, desktop, host).disabledTuiAgents).toEqual([])
  })
})
